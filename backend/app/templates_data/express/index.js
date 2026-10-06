const express = require("express");

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("<h1>Hello from Express!</h1><p>Try <a href='/api/hello'>/api/hello</a></p>");
});

app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello, world!" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Express listening on http://0.0.0.0:${port}`);
});
