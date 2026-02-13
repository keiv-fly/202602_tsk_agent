import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";

const htmlShell = (body: string) => `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Test Site</title>
    <style>
      * { transition: none !important; animation: none !important; }
    </style>
  </head>
  <body>
    ${body}
  </body>
</html>
`;

const routes: Record<string, string> = {
  "/basic-click": htmlShell(`
    <button id="toggle-btn" data-testid="toggle">Toggle</button>
    <p id="status">Off</p>
    <script>
      const button = document.getElementById('toggle-btn');
      const status = document.getElementById('status');
      button.addEventListener('click', () => {
        status.textContent = status.textContent === 'Off' ? 'On' : 'Off';
      });
    </script>
  `),
  "/delayed-mutations": htmlShell(`
    <button id="mutate-btn">Mutate</button>
    <p id="result">Start</p>
    <script>
      const button = document.getElementById('mutate-btn');
      const result = document.getElementById('result');
      button.addEventListener('click', () => {
        result.textContent = 'Step 1';
        setTimeout(() => { result.textContent = 'Step 2'; }, 200);
        setTimeout(() => { result.textContent = 'Done'; }, 400);
      });
    </script>
  `),
  "/spa-route": htmlShell(`
    <nav>
      <button id="route-btn">Go</button>
    </nav>
    <div id="view">Home</div>
    <script>
      const button = document.getElementById('route-btn');
      const view = document.getElementById('view');
      button.addEventListener('click', () => {
        history.pushState({}, '', '/spa-route?view=next');
        view.textContent = 'Next View';
      });
    </script>
  `),
  "/inputs": htmlShell(`
    <label for="text-input">Name</label>
    <input id="text-input" name="name" type="text" />
    <label for="password-input">Password</label>
    <input id="password-input" name="password" type="password" />
  `),
  "/selectors": htmlShell(`
    <button data-testid="primary">Data Test ID</button>
    <button id="secondary">With ID</button>
    <button aria-label="Aria Button">Aria</button>
    <button>Text Button</button>
  `),
  "/popup-a": htmlShell(`
    <button id="popup-btn">Open Popup</button>
    <script>
      const button = document.getElementById('popup-btn');
      button.addEventListener('click', () => {
        window.open('/popup-b', 'popup', 'width=400,height=400');
      });
    </script>
  `),
  "/popup-b": htmlShell(`
    <h1>Popup</h1>
    <button id="approve-btn">Approve</button>
  `),
  "/hover-long-text": htmlShell(`
    <div id="long-hover">
      ${"x".repeat(1200)}
    </div>
  `)
};

export const startTestServer = async () => {
  const server = createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    const page = routes[url] ?? htmlShell("<p>Not Found</p>");
    res.writeHead(url in routes ? 200 : 404, {
      "Content-Type": "text/html"
    });
    res.end(page);
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      })
  };
};

export type TestServer = Awaited<ReturnType<typeof startTestServer>>;
