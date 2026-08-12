'use strict';

const form = document.getElementById('reportForm');
const titleInput = document.getElementById('titleInput');
const descriptionInput = document.getElementById('descriptionInput');
const pageText = document.getElementById('pageText');
const statusText = document.getElementById('statusText');
const closeButton = document.getElementById('closeButton');
const cancelButton = document.getElementById('cancelButton');
const parameters = new URLSearchParams(location.search);
const pageUrl = parameters.get('url') || '';
const pageTitle = parameters.get('title') || '';
let severity = 'high';

function requestBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || 'Glitch Reaper request failed.'));
        return;
      }
      resolve(response.result);
    });
  });
}

function closeReporter() {
  parent.postMessage({ source: 'glitch-reaper', type: 'close-reporter' }, '*');
}

function setSubmitting(submitting) {
  for (const control of form.elements) {
    control.disabled = submitting;
  }
  closeButton.disabled = submitting;
}

pageText.textContent = pageUrl ? `Reporting from ${pageUrl}` : 'Reporting from the current website';

for (const button of document.querySelectorAll('[data-severity]')) {
  button.addEventListener('click', () => {
    severity = button.dataset.severity;
    for (const option of document.querySelectorAll('[data-severity]')) {
      option.classList.toggle('active', option === button);
    }
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setSubmitting(true);
  statusText.textContent = 'Saving bug…';
  try {
    await requestBackground({
      type: 'CREATE_BUG',
      bug: {
        title: titleInput.value,
        description: descriptionInput.value,
        severity,
        page: {
          url: pageUrl,
          title: pageTitle,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          scroll: { x: 0, y: 0 },
          readyState: 'complete',
          visibilityState: 'visible'
        }
      }
    });
    statusText.textContent = 'Bug saved';
    setTimeout(closeReporter, 500);
  } catch (error) {
    statusText.textContent = error.message;
    setSubmitting(false);
  }
});

closeButton.addEventListener('click', closeReporter);
cancelButton.addEventListener('click', closeReporter);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeReporter();
  }
});

titleInput.focus();
