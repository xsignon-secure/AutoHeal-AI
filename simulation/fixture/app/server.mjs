// Dummy "shop" app for the AutoHeal simulation. Plain Node, no dependencies.
// It plays the part of an app that changed since the tests were written:
//   /login    the "Log in" button is now "Sign in"        (locator drift, test bug)
//   /pricing  the Pro plan now shows $12 instead of $10   (real app change: app bug)
//   /profile  #greeting became #welcome-message           (locator drift the engine cannot map)
//   /status   a status badge (used by the flaky test)
import http from 'node:http';

const port = Number(process.env.PORT ?? 4310);

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const routes = {
  '/': page('Shop', '<h1>Dummy Shop</h1><nav><a href="/login">Login</a> <a href="/pricing">Pricing</a> <a href="/profile">Profile</a></nav>'),
  '/login': page(
    'Login',
    `<h1>Welcome back</h1>
     <form onsubmit="event.preventDefault();document.getElementById('msg').textContent='Signed in as '+document.getElementById('email').value;">
       <label for="email">Email</label><input id="email" type="email">
       <button type="submit">Sign in</button>
     </form>
     <p id="msg" role="status"></p>`,
  ),
  '/pricing': page('Pricing', '<h1>Pricing</h1><section aria-label="Pro plan"><h2>Pro</h2><p class="price" data-testid="pro-price">$12</p></section>'),
  '/profile': page('Profile', '<h1>Your profile</h1><p id="welcome-message">Hello, Ada</p>'),
  '/status': page('Status', '<h1>Status</h1><span data-testid="status">All systems normal</span>'),
};

http
  .createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const html = routes[path];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html ?? page('Not found', '<h1>Not found</h1>'));
  })
  .listen(port, '127.0.0.1', () => console.log(`dummy shop on ${port}`));
