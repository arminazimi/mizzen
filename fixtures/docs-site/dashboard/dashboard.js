fetch("data.json").then((response) => response.json()).then((data) => {
  document.getElementById("status").textContent = `${data.passed} checks passed`;
});
