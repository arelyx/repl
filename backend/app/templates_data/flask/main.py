from flask import Flask, jsonify

app = Flask(__name__)


@app.route("/")
def index():
    return "<h1>Hello from Flask!</h1><p>Try <a href='/api/hello'>/api/hello</a></p>"


@app.route("/api/hello")
def hello():
    return jsonify(message="Hello, world!")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
