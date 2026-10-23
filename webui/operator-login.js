// The operator token is submitted once, never written to browser storage. The
// server issues a short-lived HttpOnly cookie for same-origin WebUI requests.
const nativeFetch = window.fetch.bind(window);
let pendingLogin;
function signIn() {
  if (pendingLogin) return pendingLogin;
  pendingLogin = new Promise(resolve => {
    const layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#06111ef2;display:grid;place-items:center;padding:24px;color:#eef5ff;font:16px system-ui';
    const form = document.createElement('form');
    form.style.cssText = 'max-width:400px;width:100%;display:grid;gap:16px';
    const heading = document.createElement('h2'); heading.textContent = 'Sign in to your workspace';
    const label = document.createElement('label'); label.textContent = 'Operator token';
    const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.required = true; input.maxLength = 256; input.style.cssText = 'display:block;width:100%;padding:12px;margin-top:8px'; label.append(input);
    const button = document.createElement('button'); button.type = 'submit'; button.textContent = 'Sign in'; button.style.cssText = 'padding:12px;background:#a9d8ff;color:#102434;border-radius:6px';
    const message = document.createElement('p'); message.setAttribute('role', 'status');
    form.append(heading, label, button, message); layer.append(form); document.body.append(layer); input.focus();
    form.addEventListener('submit', async event => {
      event.preventDefault(); button.disabled = true;
      try {
        const response = await nativeFetch('/v1/login', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ token: input.value }) });
        input.value = '';
        if (!response.ok) { message.textContent = response.status === 429 ? 'Too many attempts. Try again later.' : 'Unable to sign in. Check your token.'; return; }
        layer.remove(); resolve();
      } catch { message.textContent = 'Unable to reach the workspace.'; }
      finally { button.disabled = false; }
    });
  }).finally(() => { pendingLogin = undefined; });
  return pendingLogin;
}
window.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/v1/')) return nativeFetch(input, options);
  const response = await nativeFetch(input, { ...options, credentials: 'same-origin' });
  if (response.status !== 401 || url.pathname === '/v1/login') return response;
  await signIn();
  return nativeFetch(input, { ...options, credentials: 'same-origin' });
};
