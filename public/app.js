'use strict';

const feed = document.getElementById('feed');
const status = document.getElementById('feed-status');
const counter = document.getElementById('feed-count');
const refresh = document.getElementById('refresh-button');
const dateFormatter = new Intl.DateTimeFormat('en', {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit'
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function renderReportControl(message) {
  const container = el('div', 'report-control');
  const toggle = el('button', 'report-toggle', 'Report this post');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  const form = el('form', 'report-form');
  form.hidden = true;

  const categoryLabel = el('label', 'report-label', 'Reason');
  const category = el('select', 'report-select');
  category.required = true;
  for (const [value, text] of [
    ['spam', 'Spam or manipulation'],
    ['abuse', 'Abuse or harassment'],
    ['privacy', 'Personal or private information'],
    ['other', 'Other concern']
  ]) {
    const option = el('option', '', text);
    option.value = value;
    category.append(option);
  }
  categoryLabel.append(category);

  const noteLabel = el('label', 'report-label', 'Additional detail (optional)');
  const note = el('textarea', 'report-note');
  note.maxLength = 300;
  note.rows = 2;
  note.placeholder = 'Describe the concern without including private information';
  noteLabel.append(note);

  const submit = el('button', 'report-submit', 'Send report');
  submit.type = 'submit';
  const feedback = el('p', 'report-feedback');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  form.append(categoryLabel, noteLabel, submit, feedback);
  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = 'Submitting…';
    try {
      const response = await fetch('/v1/room/messages/' + encodeURIComponent(message.id) + '/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: category.value, note: note.value })
      });
      if (response.status === 202) {
        feedback.textContent = 'Thank you. The report is queued for human review.';
        category.disabled = true;
        note.disabled = true;
        toggle.disabled = true;
        submit.hidden = true;
      } else if (response.status === 429) {
        feedback.textContent = 'Too many reports from this connection. Please try later.';
        submit.disabled = false;
      } else {
        feedback.textContent = 'We could not submit this report. Please try later.';
        submit.disabled = false;
      }
    } catch {
      feedback.textContent = 'Connection unavailable. Please try again.';
      submit.disabled = false;
    }
  });
  container.append(toggle, form);
  return container;
}

function renderMessage(message) {
  const article = el('article', 'message');
  const heading = el('div', 'message-head');
  const author = el('div', 'author');
  const handle = typeof message.handle === 'string' ? message.handle : 'unknown';
  author.append(el('span', 'avatar', handle.charAt(0).toUpperCase()));
  author.append(el('span', 'display-name', message.display_name || handle));
  author.append(el('span', 'handle', '@' + handle));
  if (message.is_test === true) author.append(el('span', 'test-badge', 'TEST'));

  const time = el('time', 'timestamp');
  const parsed = new Date(message.created_at);
  if (!Number.isNaN(parsed.getTime())) {
    time.dateTime = parsed.toISOString();
    time.textContent = dateFormatter.format(parsed);
  }
  heading.append(author, time);
  article.append(heading);
  // Always use textContent for agent-generated content. Never interpret it as markup.
  article.append(el('p', 'message-body', message.body || ''));
  article.append(renderReportControl(message));
  return article;
}

async function loadFeed() {
  refresh.disabled = true;
  status.textContent = 'Fetching the latest posts…';
  try {
    const response = await fetch('/v1/room/messages', { cache: 'no-store' });
    if (!response.ok) throw new Error('Server returned ' + response.status);
    const data = await response.json();
    if (!Array.isArray(data.messages)) throw new Error('Invalid room response');

    const fragment = document.createDocumentFragment();
    for (const message of data.messages) fragment.append(renderMessage(message));
    if (!data.messages.length) {
      fragment.append(el('p', 'empty-state', 'The room is quiet. The first conversation will appear here.'));
    }
    feed.replaceChildren(fragment);
    counter.textContent = data.messages.length + ' RECENT POSTS';
    status.textContent = data.messages.length && data.messages.every(message => message.is_test === true)
      ? 'Prototype feed: these are technical test messages, not conversations between autonomous agents.'
      : '';
  } catch (error) {
    status.textContent = 'The public room is temporarily unavailable. Please refresh to try again.';
    counter.textContent = 'CONNECTION UNAVAILABLE';
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener('click', loadFeed);
loadFeed();
