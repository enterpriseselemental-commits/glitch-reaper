from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "test-artifacts"

MOCK_EXTENSION = r"""
(() => {
  const now = Date.now();
  const settings = {
    profileId: 'profile_smoke',
    profileName: 'Developer',
    profileRole: 'Developer',
    projectName: 'Glitch Reaper',
    blurSensitiveData: false,
    detectionEnabled: true,
    onboardingComplete: true,
    allowedHosts: ['example.com'],
    excludedHosts: [],
    retentionDays: 14,
    maxIncidents: 250,
    capturePageTitle: false,
    includeQueryParameters: false,
    detectConsoleErrors: true,
    detectNetworkErrors: true,
    detectResourceErrors: true,
    detectPerformanceFreezes: true,
    detectMemoryLeaks: true,
    longTaskMs: 750,
    memorySampleSeconds: 15,
    memoryWindowSeconds: 90,
    memoryGrowthMb: 32,
    datastoreMode: 'local',
    supabaseUrl: '',
    supabaseKey: '',
    projectId: '',
    ingestToken: '',
    adminToken: '',
    autoSync: true
  };
  const bugs = [
    {
      id: 'bug_js', fingerprint: 'fp_js', kind: 'javascript_error',
      title: 'Cannot read properties of undefined',
      description: 'An uncaught JavaScript error occurred in app.js.',
      severity: 'high', status: 'found', source: 'automatic',
      detectedAt: now - 90000, firstSeen: now - 90000, lastSeen: now - 12000,
      fixedAt: null, occurrences: 4, page: { url: 'https://example.com/dashboard' },
      evidence: { source: 'https://example.com/app.js', line: 84, column: 16 },
      sync: { state: 'local', lastAttempt: 0, error: '' }
    },
    {
      id: 'bug_api', fingerprint: 'fp_api', kind: 'fetch_http_error',
      title: 'Server returned HTTP 500',
      description: 'GET https://example.com/api/profile returned 500.',
      severity: 'high', status: 'found', source: 'automatic',
      detectedAt: now - 70000, firstSeen: now - 70000, lastSeen: now - 22000,
      fixedAt: null, occurrences: 2, page: { url: 'https://example.com/profile' },
      evidence: { method: 'GET', status: 500, url: 'https://example.com/api/profile' },
      sync: { state: 'local', lastAttempt: 0, error: '' }
    },
    {
      id: 'bug_manual', fingerprint: 'manual_1', kind: 'manual_bug',
      title: 'Settings button overlaps heading',
      description: 'The settings button covers the page heading at narrow widths.',
      severity: 'medium', status: 'fixed', source: 'manual',
      detectedAt: now - 180000, firstSeen: now - 180000, lastSeen: now - 160000,
      fixedAt: now - 60000, occurrences: 1, page: { url: 'https://example.com/settings' },
      evidence: {}, sync: { state: 'local', lastAttempt: 0, error: '' }
    }
  ];
  const clone = value => JSON.parse(JSON.stringify(value));
  const queryData = () => ({
    settings: clone(settings),
    bugs: clone(bugs),
    incidents: clone(bugs),
    profiles: [],
    storage: { bytesUsed: 24712, incidentCount: bugs.length, pendingCount: 0 },
    sync: { lastSyncAt: 0, lastError: '', lastRemoteCount: 0 }
  });
  const respond = message => {
    switch (message?.type) {
      case 'QUERY_DATA': return queryData();
      case 'GET_SETTINGS': return { settings: clone(settings) };
      case 'SAVE_SETTINGS': Object.assign(settings, message.settings || {}); return { settings: clone(settings) };
      case 'UPDATE_BUG': {
        const bug = bugs.find(item => item.id === message.id);
        if (!bug) throw new Error('Bug not found.');
        Object.assign(bug, message.changes || {}, { lastSeen: Date.now() });
        if (bug.status === 'fixed') bug.fixedAt = Date.now();
        if (bug.status === 'found') bug.fixedAt = null;
        return { bug: clone(bug), remoteWarning: '' };
      }
      case 'DELETE_BUG': {
        const index = bugs.findIndex(item => item.id === message.id);
        if (index >= 0) bugs.splice(index, 1);
        return { deleted: true };
      }
      case 'CREATE_BUG': {
        const bug = {
          id: `manual_${Date.now()}`, fingerprint: `manual_${Date.now()}`,
          kind: 'manual_bug', title: message.bug.title, description: message.bug.description,
          severity: message.bug.severity, status: 'found', source: 'manual',
          detectedAt: Date.now(), firstSeen: Date.now(), lastSeen: Date.now(), fixedAt: null,
          occurrences: 1, page: message.bug.page, evidence: {}, sync: { state: 'local', lastAttempt: 0, error: '' }
        };
        bugs.push(bug);
        window.__mockState.createdBug = clone(bug);
        return { bug: clone(bug) };
      }
      case 'EXPORT_REPORT': return { report: { schemaVersion: 3, data: { incidents: clone(bugs), profiles: [] } } };
      case 'IMPORT_REPORT': return { importedIncidents: 1, mergedIncidents: 0, importedProfiles: 0 };
      case 'CONNECT_ACTIVE_HOST': settings.allowedHosts = ['example.com']; return { host: 'example.com', settings: clone(settings) };
      case 'TEST_DATASTORE': return { role: 'admin' };
      case 'SYNC_NOW': return { synced: 0 };
      case 'OPEN_REPORTER_ACTIVE': return { opened: true };
      case 'CLEAR_DATA': bugs.splice(0, bugs.length); return { cleared: true };
      default: throw new Error(`Unknown mock request: ${message?.type || ''}`);
    }
  };
  window.__mockState = { settings, bugs, createdBug: null };
  window.__mockPermissionRequests = [];
  window.browser = {
    permissions: {
      getAll: () => Promise.resolve({ data_collection: [] }),
      request: request => {
        window.__mockPermissionRequests.push(structuredClone(request));
        return Promise.resolve(true);
      }
    }
  };
  window.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ name: 'Glitch Reaper', version: '2.1.7' }),
      getURL: path => new URL(path, document.baseURI).href,
      openOptionsPage: () => Promise.resolve(),
      sendMessage: (message, callback) => {
        queueMicrotask(() => {
          try { callback({ ok: true, result: respond(message) }); }
          catch (error) { callback({ ok: false, error: error.message }); }
        });
      }
    },
    permissions: {
      contains: (_permissions, callback) => queueMicrotask(() => callback(true)),
      request: (_permissions, callback) => queueMicrotask(() => callback(true))
    },
    tabs: {
      getCurrent: callback => queueMicrotask(() => callback(null)),
      remove: () => undefined
    }
  };
})();
"""


def assert_within_viewport(page: Page, selector: str) -> None:
    box = page.locator(selector).bounding_box()
    viewport = page.viewport_size
    assert box is not None and viewport is not None
    assert box["x"] >= -1 and box["y"] >= -1
    assert box["x"] + box["width"] <= viewport["width"] + 1
    assert box["y"] + min(box["height"], viewport["height"]) <= viewport["height"] + 1




def click_without_autoscroll(page: Page, selector: str) -> None:
    box = page.locator(selector).bounding_box()
    assert box is not None
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)

def load_surface(page: Page, html_path: Path, css_paths: list[Path], script_paths: list[Path]) -> None:
    html = html_path.read_text(encoding="utf-8")
    html = re.sub(r'<link[^>]+rel=["\']stylesheet["\'][^>]*>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'<script[^>]+src=["\'][^"\']+["\'][^>]*></script>', '', html, flags=re.IGNORECASE)
    page.set_content(html, wait_until="domcontentloaded")
    page.evaluate(MOCK_EXTENSION)
    for css_path in css_paths:
        page.add_style_tag(content=css_path.read_text(encoding="utf-8"))
    for script_path in script_paths:
        page.add_script_tag(content=script_path.read_text(encoding="utf-8"))


def run() -> dict[str, Any]:
    ARTIFACTS.mkdir(exist_ok=True)
    for item in ARTIFACTS.iterdir():
        if item.is_file():
            item.unlink()
        elif item.is_dir():
            shutil.rmtree(item)

    theme_css = ROOT / "shared" / "theme.css"
    dashboard_css = ROOT / "dashboard" / "dashboard.css"
    dashboard_scripts = [ROOT / "shared" / "incident-utils.js", ROOT / "dashboard" / "dashboard.js"]
    checks: list[str] = []

    with sync_playwright() as playwright:
        chromium_path = os.environ.get("CHROMIUM_PATH")
        if not chromium_path:
            for candidate in ("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"):
                if Path(candidate).exists():
                    chromium_path = candidate
                    break
        launch_options: dict[str, Any] = {"headless": True}
        if chromium_path:
            launch_options["executable_path"] = chromium_path
        browser = playwright.chromium.launch(**launch_options)

        popup = browser.new_page(viewport={"width": 800, "height": 600})
        console_errors: list[str] = []
        popup.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        load_surface(
            popup,
            ROOT / "dashboard" / "dashboard.html",
            [theme_css, dashboard_css],
            dashboard_scripts
        )
        popup.wait_for_selector("#bugList .bug-row", timeout=10000)
        assert popup.locator("#bugList .bug-row").count() == 3
        assert popup.locator("#tutorialOverlay").is_hidden()
        assert_within_viewport(popup, ".app-shell")
        popup.screenshot(path=str(ARTIFACTS / "dashboard.png"))
        checks.append("dashboard renders three reports at 800 by 600 without outer overflow")

        popup.locator("#bugList .bug-row .row-select").first.click()
        selected_title = popup.locator("#detailTitle").inner_text().strip()
        assert selected_title == "Cannot read properties of undefined"
        popup.locator("#fixButton").click()
        popup.wait_for_function("window.__mockState.bugs[0].status === 'fixed'")
        assert popup.locator("#fixButton").inner_text().strip() == "REOPEN"
        checks.append("report selection and fixed status update")

        popup.locator('[data-view="settings"]').click()
        assert popup.locator("#settingsPanel").is_visible()
        assert popup.locator("#filterButton").is_hidden()
        assert popup.locator('[data-view="settings"]').get_attribute("aria-pressed") == "true"
        assert popup.locator('[data-view="bugs"]').get_attribute("aria-pressed") == "false"
        assert popup.locator(".dock-button.active").count() == 1
        assert popup.locator("#closeButton svg").count() == 1
        checks.append("popup settings navigation, selected stroke and vector close control")

        popup.locator("#tutorialButton").click()
        assert popup.locator("#tutorialOverlay").is_visible()
        assert_within_viewport(popup, ".tutorial-modal")
        assert popup.locator('[data-step="0"] #tourWebsite').count() == 0
        assert popup.locator('[data-step="0"] #tourProjectName').is_visible()
        assert popup.locator('[data-step="0"] #tourProfileName').is_visible()
        popup.locator("#tutorialNext").click()
        assert popup.locator('[data-step="1"]').is_visible()
        storage_copy = popup.locator('[data-step="1"]').inner_text().lower()
        assert "shared project database" in storage_copy
        popup.locator("#tutorialNext").click()
        assert popup.locator('[data-step="2"] #tourWebsite').is_visible()
        assert popup.locator('[data-step="2"] #tourDetectionEnabled').is_visible()
        assert_within_viewport(popup, ".tutorial-modal")
        popup.screenshot(path=str(ARTIFACTS / "onboarding.png"))
        popup.locator("#tutorialBack").click()
        popup.locator("#tutorialBack").click()
        popup.keyboard.press("Escape")
        assert popup.locator("#tutorialOverlay").is_hidden()
        checks.append("onboarding keeps website entry with bug detection and uses product-only copy")

        settings = browser.new_page(viewport={"width": 1280, "height": 700})
        settings.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        load_surface(
            settings,
            ROOT / "dashboard" / "settings.html",
            [theme_css, dashboard_css],
            dashboard_scripts
        )
        settings.wait_for_selector("#settingsPanel", timeout=10000)
        metrics = settings.locator("#settingsForm").evaluate(
            "element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY })"
        )
        assert metrics["scrollHeight"] > metrics["clientHeight"]
        assert metrics["overflowY"] in {"auto", "scroll"}
        switch_selectors = [
            "#detectionEnabled",
            "#blurSensitiveData",
            "#detectConsoleErrors",
            "#detectNetworkErrors",
            "#detectResourceErrors",
            "#detectPerformanceFreezes",
            "#detectMemoryLeaks",
            "#includeQueryParameters"
        ]
        for selector in switch_selectors:
            control = settings.locator(selector)
            control.scroll_into_view_if_needed()
            before_toggle = settings.locator("#settingsForm").evaluate("element => element.scrollTop")
            click_without_autoscroll(settings, selector)
            settings.wait_for_timeout(200 if selector in {"#detectionEnabled", "#blurSensitiveData"} else 50)
            after_toggle = settings.locator("#settingsForm").evaluate("element => element.scrollTop")
            assert abs(after_toggle - before_toggle) <= 1, (selector, before_toggle, after_toggle)

        settings.locator("#datastoreMode").scroll_into_view_if_needed()
        before_datastore = settings.locator("#settingsForm").evaluate("element => element.scrollTop")
        settings.locator("#datastoreMode").select_option("supabase")
        settings.wait_for_timeout(100)
        after_datastore = settings.locator("#settingsForm").evaluate("element => element.scrollTop")
        assert abs(after_datastore - before_datastore) <= 1
        assert settings.locator("#supabaseFields").is_visible()
        settings.locator("#autoSync").scroll_into_view_if_needed()
        before_auto_sync = settings.locator("#settingsForm").evaluate("element => element.scrollTop")
        click_without_autoscroll(settings, "#autoSync")
        settings.wait_for_timeout(50)
        after_auto_sync = settings.locator("#settingsForm").evaluate("element => element.scrollTop")
        assert abs(after_auto_sync - before_auto_sync) <= 1
        settings.locator("#supabaseUrl").fill("https://test.supabase.co")
        settings.locator("#supabaseKey").fill("sb_publishable_test")
        settings.locator("#projectId").fill("project-id")
        settings.locator("#ingestToken").fill("ingest-token")
        settings.locator("#saveButton").click()
        settings.wait_for_function("window.__mockPermissionRequests.length === 1")
        requested_permissions = settings.evaluate("window.__mockPermissionRequests[0].data_collection")
        assert requested_permissions == [
            "personallyIdentifyingInfo",
            "browsingActivity",
            "websiteContent",
            "technicalAndInteraction"
        ]
        checks.append("cloud settings request the declared firefox data permissions")
        settings.locator("#datastoreMode").select_option("local")
        settings.wait_for_timeout(100)
        assert settings.locator("#supabaseFields").is_hidden()
        settings.locator("#settingsForm").evaluate("element => { element.scrollTop = element.scrollHeight; }")
        settings.screenshot(path=str(ARTIFACTS / "settings.png"))
        assert settings.locator("#saveButton").is_visible()
        session = settings.context.new_cdp_session(settings)
        session.send("Performance.enable")
        before_metrics = {item["name"]: item["value"] for item in session.send("Performance.getMetrics")["metrics"]}
        started = __import__("time").monotonic()
        settings.wait_for_timeout(3000)
        elapsed = __import__("time").monotonic() - started
        after_metrics = {item["name"]: item["value"] for item in session.send("Performance.getMetrics")["metrics"]}
        cpu_percent = max(0.0, after_metrics.get("TaskDuration", 0.0) - before_metrics.get("TaskDuration", 0.0)) / elapsed * 100
        heap_mb = after_metrics.get("JSHeapUsedSize", 0.0) / 1048576
        assert cpu_percent < 5.0
        assert heap_mb < 100.0
        checks.append(f"full settings scroll, stable switch changes, {cpu_percent:.3f}% idle CPU and {heap_mb:.3f} MB JavaScript heap")

        reporter = browser.new_page(viewport={"width": 1280, "height": 800})
        reporter.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        load_surface(
            reporter,
            ROOT / "manual-report" / "manual-report.html",
            [theme_css, ROOT / "manual-report" / "manual-report.css"],
            [ROOT / "manual-report" / "manual-report.js"]
        )
        reporter.wait_for_selector("#reportForm", timeout=10000)
        reporter.locator("#titleInput").fill("Header overlap")
        reporter.locator("#descriptionInput").fill("The header overlaps the settings button at narrow widths.")
        reporter.locator('[data-severity="medium"]').click()
        reporter.locator("#reportForm button[type='submit']").click()
        reporter.wait_for_function("window.__mockState.createdBug !== null", timeout=10000)
        created = reporter.evaluate("window.__mockState.createdBug")
        assert created["title"] == "Header overlap"
        assert created["source"] == "manual"
        reporter.screenshot(path=str(ARTIFACTS / "manual-report.png"))
        checks.append("manual report form submission")

        assert console_errors == [], console_errors
        checks.append("no browser console errors across dashboard, settings and reporter")
        browser.close()

    result = {"passed": len(checks), "failed": 0, "checks": checks}
    (ARTIFACTS / "ui-browser-smoke-results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
