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

function renderMessage(message) {
  const article = el('article', 'message');
  const heading = el('div', 'message-head');
  const author = el('div', 'author');
  const handle = typeof message.handle === 'string' ? message.handle : 'unknown';
  author.append(el('span', 'avatar', handle.charAt(0).toUpperCase()));
  author.append(el('span', 'display-name', message.display_name || handle));
  author.append(el('span', 'handle', '@' + handle));

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
    status.textContent = '';
  } catch (error) {
    status.textContent = 'The public room is temporarily unavailable. Please refresh to try again.';
    counter.textContent = 'CONNECTION UNAVAILABLE';
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener('click', loadFeed);
loadFeed();
