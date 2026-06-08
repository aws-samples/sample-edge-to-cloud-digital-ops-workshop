// Reads ?did=ws-slot03 from the URL and replaces the placeholder deployment ID
// in all code blocks and inline code on the page. The facilitator hands each
// participant a URL with their deployment ID already embedded, e.g.:
//   https://workshop.example.com/01-observe/block-2-iot-job/?did=ws-slot03
//
// Falls back to the value stored in sessionStorage so the ID persists as the
// participant navigates between pages without it appearing in every URL.

(function () {
  const PLACEHOLDER = "ws-slot00";
  const PARAM = "did";

  function getDeploymentId() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get(PARAM);
    if (fromUrl) {
      sessionStorage.setItem(PARAM, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(PARAM);
  }

  function replace(node, id) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue.includes(PLACEHOLDER)) {
        node.nodeValue = node.nodeValue.replaceAll(PLACEHOLDER, id);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      for (const child of node.childNodes) {
        replace(child, id);
      }
    }
  }

  document$.subscribe(function () {
    const id = getDeploymentId();
    if (!id || id === PLACEHOLDER) return;

    // Target code blocks and inline code only — don't rewrite prose or nav
    document.querySelectorAll("code, pre").forEach(function (el) {
      replace(el, id);
    });

    // Also update the "Your deployment ID" banner if present
    document.querySelectorAll("[data-deployment-id]").forEach(function (el) {
      el.textContent = id;
    });
  });
})();
