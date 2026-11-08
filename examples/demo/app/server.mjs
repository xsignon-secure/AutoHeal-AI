// A tiny shop for the AutoHeal demo. Plain Node, no dependencies.
// Run `./break-the-ui.sh` to make the kinds of change real teams make every week.
import http from 'node:http';

const port = Number(process.env.PORT ?? 3000);

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:2rem;max-width:40rem}button{font:inherit;padding:.4rem .9rem}nav a{margin-right:1rem}</style>
</head><body><nav><a href="/">Shop</a><a href="/login">Account</a><a href="/pricing">Pricing</a></nav>${body}</body></html>`;

const routes = {
  '/': page(
    'Shop',
    `<h1>Demo Shop</h1>
     <section aria-label="Coffee mug">
       <h2>Coffee mug</h2><p>$8</p>
       <button data-testid="add-mug" onclick="document.getElementById('cart').textContent='1 item in your cart'">Add to cart</button>
     </section>
     <p id="cart" role="status">Your cart is empty</p>`,
  ),
  '/login': page(
    'Account',
    `<h1>Welcome back</h1>
     <form onsubmit="event.preventDefault();document.getElementById('msg').textContent='Signed in as '+document.getElementById('email').value;">
       <label for="email">Email</label> <input id="email" type="email">
       <button type="submit">Log in</button>
     </form>
     <p id="msg" role="status"></p>`,
  ),
  '/pricing': page('Pricing', '<h1>Pricing</h1><section aria-label="Pro plan"><h2>Pro</h2><p data-testid="pro-price">$10 a month</p></section>'),
};

http
  .createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const html = routes[path];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html ?? page('Not found', '<h1>Not found</h1>'));
  })
  .listen(port, '127.0.0.1', () => console.log(`Demo shop on http://127.0.0.1:${port}`));
