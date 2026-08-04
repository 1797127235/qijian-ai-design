import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./tokens.css";
import "./shell.css";
import "./screens.css";

createRoot(document.getElementById("root")!).render(<App />);
