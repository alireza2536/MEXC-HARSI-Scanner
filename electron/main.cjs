// Electron 22 loads the application entry point through CommonJS.
// The application itself uses ES modules, so bootstrap it with dynamic import.
import("./main.js").catch((error) => {
  console.error("Harsi desktop bootstrap failed:", error);
  process.exitCode = 1;
});
