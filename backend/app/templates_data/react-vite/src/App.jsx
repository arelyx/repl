import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main style={{ fontFamily: "sans-serif", textAlign: "center", marginTop: "15vh" }}>
      <h1>Hello, React!</h1>
      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
      <p>Edit <code>src/App.jsx</code> and save to reload.</p>
    </main>
  );
}
