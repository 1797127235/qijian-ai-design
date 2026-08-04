import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./tokens.css";
import "./desk/desk.css";

createRoot(document.getElementById("root")!).render(<App />);
