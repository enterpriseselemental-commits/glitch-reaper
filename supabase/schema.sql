-- enable password hashing for project tokens
create extension if not exists pgcrypto with schema extensions;


-- store one project row and the hashed access tokens
create table if not exists public.glitch_reaper_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ingest_token_hash text not null,
  admin_token_hash text not null,
  created_at timestamptz not null default now()
);


-- store the latest payload and status for each report
create table if not exists public.glitch_reaper_incidents (
  project_id uuid not null references public.glitch_reaper_projects(id) on delete cascade,
  id text not null,
  fingerprint text not null,
  status text not null default 'found' check (status in ('found', 'fixed')),
  occurrences integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, id)
);

create index if not exists glitch_reaper_incidents_project_last_seen_idx
  on public.glitch_reaper_incidents(project_id, last_seen desc);

create index if not exists glitch_reaper_incidents_project_fingerprint_idx
  on public.glitch_reaper_incidents(project_id, fingerprint);

-- block direct table access through the data api
alter table public.glitch_reaper_projects enable row level security;
alter table public.glitch_reaper_incidents enable row level security;

revoke all on public.glitch_reaper_projects from anon, authenticated;
revoke all on public.glitch_reaper_incidents from anon, authenticated;

-- create a project from the sql editor and return its uuid
create or replace function public.gr_create_project(
  p_name text,
  p_ingest_token text,
  p_admin_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id uuid;
begin
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'Project name is required';
  end if;
  if length(coalesce(p_ingest_token, '')) < 24 then
    raise exception 'Ingest token must be at least 24 characters';
  end if;
  if length(coalesce(p_admin_token, '')) < 32 then
    raise exception 'Admin token must be at least 32 characters';
  end if;

  insert into public.glitch_reaper_projects(name, ingest_token_hash, admin_token_hash)
  values (
    trim(p_name),
    extensions.crypt(p_ingest_token, extensions.gen_salt('bf', 12)),
    extensions.crypt(p_admin_token, extensions.gen_salt('bf', 12))
  )
  returning id into v_id;

  return jsonb_build_object('project_id', v_id, 'name', trim(p_name));
end;
$$;

-- check an ingest or admin token without exposing its hash
create or replace function public.gr_ping(
  p_project_id uuid,
  p_token text,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_valid boolean := false;
begin
  if p_role = 'admin' then
    select extensions.crypt(p_token, admin_token_hash) = admin_token_hash
    into v_valid
    from public.glitch_reaper_projects
    where id = p_project_id;
  else
    select extensions.crypt(p_token, ingest_token_hash) = ingest_token_hash
    into v_valid
    from public.glitch_reaper_projects
    where id = p_project_id;
  end if;

  if coalesce(v_valid, false) is false then
    raise exception 'Invalid project token';
  end if;

  return jsonb_build_object('ok', true, 'role', case when p_role = 'admin' then 'admin' else 'ingest' end);
end;
$$;

-- insert or update a small batch of reports from an extension
create or replace function public.gr_ingest_incidents(
  p_project_id uuid,
  p_ingest_token text,
  p_incidents jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_valid boolean := false;
  v_incident jsonb;
  v_count integer := 0;
  v_id text;
  v_first timestamptz;
  v_last timestamptz;
begin
  select extensions.crypt(p_ingest_token, ingest_token_hash) = ingest_token_hash
  into v_valid
  from public.glitch_reaper_projects
  where id = p_project_id;

  if coalesce(v_valid, false) is false then
    raise exception 'Invalid ingest token';
  end if;

  if jsonb_typeof(p_incidents) <> 'array' then
    raise exception 'Incidents must be a JSON array';
  end if;

  if jsonb_array_length(p_incidents) > 50 then
    raise exception 'A maximum of 50 incidents can be ingested at once';
  end if;

  for v_incident in select value from jsonb_array_elements(p_incidents)
  loop
    v_id := left(coalesce(v_incident->>'id', ''), 120);
    if length(v_id) < 3 then
      continue;
    end if;

    begin
      v_first := timestamptz 'epoch' + (coalesce((v_incident->>'firstSeen')::bigint, (extract(epoch from now()) * 1000)::bigint) / 1000.0) * interval '1 second';
    exception when others then
      v_first := now();
    end;

    begin
      v_last := timestamptz 'epoch' + (coalesce((v_incident->>'lastSeen')::bigint, (extract(epoch from now()) * 1000)::bigint) / 1000.0) * interval '1 second';
    exception when others then
      v_last := now();
    end;

    insert into public.glitch_reaper_incidents(
      project_id,
      id,
      fingerprint,
      status,
      occurrences,
      first_seen,
      last_seen,
      payload
    )
    values (
      p_project_id,
      v_id,
      left(coalesce(v_incident->>'fingerprint', v_id), 120),
      'found',
      greatest(1, least(1000000, coalesce((v_incident->>'occurrences')::integer, 1))),
      v_first,
      v_last,
      v_incident
    )
    on conflict (project_id, id) do update
    set fingerprint = excluded.fingerprint,
        status = case
          when public.glitch_reaper_incidents.status = 'fixed'
            and excluded.last_seen > public.glitch_reaper_incidents.updated_at
          then 'found'
          else public.glitch_reaper_incidents.status
        end,
        occurrences = greatest(public.glitch_reaper_incidents.occurrences, excluded.occurrences),
        first_seen = least(public.glitch_reaper_incidents.first_seen, excluded.first_seen),
        last_seen = greatest(public.glitch_reaper_incidents.last_seen, excluded.last_seen),
        payload = excluded.payload,
        updated_at = now();

    v_count := v_count + 1;
  end loop;

  delete from public.glitch_reaper_incidents
  where project_id = p_project_id
    and last_seen < now() - interval '90 days';

  delete from public.glitch_reaper_incidents
  where project_id = p_project_id
    and id in (
      select id
      from public.glitch_reaper_incidents
      where project_id = p_project_id
      order by last_seen desc
      offset 5000
    );

  return jsonb_build_object('ok', true, 'ingested', v_count);
end;
$$;

-- return the newest reports to a developer installation
create or replace function public.gr_list_incidents(
  p_project_id uuid,
  p_admin_token text,
  p_limit integer default 250
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_valid boolean := false;
  v_result jsonb;
begin
  select extensions.crypt(p_admin_token, admin_token_hash) = admin_token_hash
  into v_valid
  from public.glitch_reaper_projects
  where id = p_project_id;

  if coalesce(v_valid, false) is false then
    raise exception 'Invalid admin token';
  end if;

  select coalesce(
    jsonb_agg(
      payload || jsonb_build_object(
        'status', status,
        'occurrences', occurrences,
        'firstSeen', floor(extract(epoch from first_seen) * 1000),
        'lastSeen', floor(extract(epoch from last_seen) * 1000),
        'fixedAt', case when status = 'fixed' then floor(extract(epoch from updated_at) * 1000) else null end
      )
      order by last_seen desc
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select *
    from public.glitch_reaper_incidents
    where project_id = p_project_id
    order by last_seen desc
    limit greatest(1, least(coalesce(p_limit, 250), 1000))
  ) as incidents;

  return v_result;
end;
$$;

-- allow developers to mark a report fixed or found again
create or replace function public.gr_update_incident_status(
  p_project_id uuid,
  p_admin_token text,
  p_incident_id text,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_valid boolean := false;
  v_updated integer := 0;
begin
  if p_status not in ('found', 'fixed') then
    raise exception 'Invalid status';
  end if;

  select extensions.crypt(p_admin_token, admin_token_hash) = admin_token_hash
  into v_valid
  from public.glitch_reaper_projects
  where id = p_project_id;

  if coalesce(v_valid, false) is false then
    raise exception 'Invalid admin token';
  end if;

  update public.glitch_reaper_incidents
  set status = p_status,
      payload = payload || jsonb_build_object(
        'status', p_status,
        'fixedAt', case when p_status = 'fixed' then floor(extract(epoch from now()) * 1000) else null end
      ),
      updated_at = now()
  where project_id = p_project_id and id = left(p_incident_id, 120);

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'Incident not found';
  end if;

  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

-- delete one report after an admin token check
create or replace function public.gr_delete_incident(
  p_project_id uuid,
  p_admin_token text,
  p_incident_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_valid boolean := false;
  v_deleted integer := 0;
begin
  select extensions.crypt(p_admin_token, admin_token_hash) = admin_token_hash
  into v_valid
  from public.glitch_reaper_projects
  where id = p_project_id;

  if coalesce(v_valid, false) is false then
    raise exception 'Invalid admin token';
  end if;

  delete from public.glitch_reaper_incidents
  where project_id = p_project_id and id = left(p_incident_id, 120);

  get diagnostics v_deleted = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_deleted);
end;
$$;

-- expose only the restricted rpc functions used by the extension
revoke all on function public.gr_create_project(text, text, text) from public, anon, authenticated;
revoke all on function public.gr_ping(uuid, text, text) from public;
revoke all on function public.gr_ingest_incidents(uuid, text, jsonb) from public;
revoke all on function public.gr_list_incidents(uuid, text, integer) from public;
revoke all on function public.gr_update_incident_status(uuid, text, text, text) from public;
revoke all on function public.gr_delete_incident(uuid, text, text) from public;

grant execute on function public.gr_ping(uuid, text, text) to anon, authenticated;
grant execute on function public.gr_ingest_incidents(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.gr_list_incidents(uuid, text, integer) to anon, authenticated;
grant execute on function public.gr_update_incident_status(uuid, text, text, text) to anon, authenticated;
grant execute on function public.gr_delete_incident(uuid, text, text) to anon, authenticated;
