const button = document.querySelector("#try-button");
const result = document.querySelector("#result");
let tries = 0;

button?.addEventListener("click", () => {
  tries += 1;
  result.textContent = `The app is working. You tried it ${tries} time${tries === 1 ? "" : "s"}.`;
});
