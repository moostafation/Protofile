import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { hub } from "./app/hub";
import { useStore } from "./app/store";
import "./app/styles.css";
import "./app/desktop.css";

// Handle for automated UI tests and the browser console.
(window as unknown as { __plantforge: unknown }).__plantforge = { store: useStore, hub };

createRoot(document.getElementById("root")!).render(<App />);
