import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if (import.meta.env.DEV && "serviceWorker" in navigator) {
  // A cached Vite module can become incompatible with a newly edited module.
  void (async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const wasControlled = Boolean(navigator.serviceWorker.controller);
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("pondsense-app-")).map((key) => caches.delete(key)));
    if (wasControlled && !sessionStorage.getItem("pondsense.dev-cache-reset")) {
      sessionStorage.setItem("pondsense.dev-cache-reset", "1");
      window.location.reload();
    }
  })().catch(console.error);
} else if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
