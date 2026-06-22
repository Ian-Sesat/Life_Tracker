import React from "react";
import ReactDOM from "react-dom/client";
import App from "./LifeTracker.jsx";

// full-height, no default margin
const style = document.createElement("style");
style.textContent = `
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body { background: #FAF8F2; }
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
