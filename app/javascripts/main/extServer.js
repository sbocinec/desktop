const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const url = require('url');

export class ExtensionsServer {
  constructor() {
    this.port = 45653;
    this.createServer();
  }

  getHost() {
    return `http://localhost:${this.port}/`;
  }

  createServer() {
    function handleRequest(req, res) {
      const extensionsFolder = "Extensions";
      const extensionsDir = path.join(app.getPath('userData'), extensionsFolder);
      const pathName = url.parse(req.url).pathname;
      // Normalize path (parse '..' and '.') so that we prevent path traversal by joining a fully resolved path to the Extensions dir.
      const modifiedReqUrl = path.normalize(pathName.replace(extensionsFolder, ""));
      const filePath = path.join(extensionsDir, modifiedReqUrl);

      fs.exists(filePath, function (exists) {
        if (exists && fs.lstatSync(filePath).isFile()) {
          const ext = path.parse(filePath).ext;
          const mimeType = mime.lookup(ext);
          res.setHeader("Content-Type", `${mimeType}; charset=utf-8`);
          res.writeHead(200, {
            'Access-Control-Allow-Origin': '*'
          });
          fs.createReadStream(filePath).pipe(res);
          return;
        }

        res.writeHead(404);
        res.write('Unable to load extension. Please restart the application and try again. If the issue persists, try uninstalling then reinstalling the extension.');
        res.end();
      });
    }

    const server = http.createServer(handleRequest);
    server.listen(this.port, '127.0.0.1', () => {
      console.log(`Extensions server started at http://localhost:${this.port}`);
    });
  }
}
