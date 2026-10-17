// "Name this profile": the name agents see for this Chrome profile. The service worker passes it on
// to the helper whenever it changes.

const input = document.getElementById('name');
const status = document.getElementById('status');
const say = (message, error = false) => {
  status.textContent = message;
  status.className = error ? 'error' : '';
};

chrome.storage.local.get('profileName').then(({ profileName }) => {
  input.value = profileName ?? '';
  input.select();
});

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = input.value.replace(/\s+/g, ' ').trim().slice(0, 100);
  await chrome.storage.local.set({ profileName: name });
  say(name ? `Saved. Agents now see this profile as “${name}”.` : 'Saved. This profile has no name now.');
  setTimeout(() => window.close(), 1200);
});

// The email takes a permission Tabhand doesn't otherwise need: asked for here, used once to fill in
// the field, and given straight back.
const EMAIL = { permissions: ['identity', 'identity.email'] };
document.getElementById('email').addEventListener('click', async () => {
  try {
    if (!(await chrome.permissions.request(EMAIL))) {
      say('Chrome didn’t let Tabhand read the email, so nothing was filled in. Type a name instead.', true);
      return;
    }
    const { email } = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    if (email) {
      input.value = email;
      input.focus();
      say('Filled in. Save to use it.');
    } else {
      say('This profile isn’t signed in to Chrome with a Google account. Type a name instead.', true);
    }
  } catch (error) {
    say(String(error?.message ?? error), true);
  } finally {
    chrome.permissions.remove(EMAIL).catch(() => {});
  }
});
