// Reads ?did=ws-slot03 and ?aid=123456789012 from the URL and replaces the
// placeholder deployment ID and account ID in all code blocks and inline code
// on the page. The facilitator hands each participant a URL with both values
// embedded, e.g.:
//   https://workshop.example.com/01-observe/block-2-s3/?did=ws-slot03&aid=123456789012
//
// Falls back to values stored in sessionStorage so they persist as the
// participant navigates between pages without them appearing in every URL.

(function () {
  const DEPLOYMENT_PLACEHOLDER = "ws-slot00";
  const ACCOUNT_PLACEHOLDER = "000000000000";
  const DID_PARAM = "did";
  const AID_PARAM = "aid";

  function getParam(key, storageKey) {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get(key);
    if (fromUrl) {
      sessionStorage.setItem(storageKey ?? key, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(storageKey ?? key);
  }

  function replaceInNode(node, from, to) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue.includes(from)) {
        node.nodeValue = node.nodeValue.replaceAll(from, to);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      for (const child of node.childNodes) {
        replaceInNode(child, from, to);
      }
    }
  }

  // Intercept all internal link clicks in the capture phase — before Material's
  // instant-navigation handler reads the href — and stamp the params onto them.
  document.addEventListener("click", function (e) {
    const a = e.target.closest("a");
    if (!a || !a.href) return;
    const did = sessionStorage.getItem(DID_PARAM);
    const aid = sessionStorage.getItem(AID_PARAM);
    if (!did && !aid) return;
    try {
      const u = new URL(a.href);
      if (u.origin !== window.location.origin) return;
      if (did) u.searchParams.set(DID_PARAM, did);
      if (aid) u.searchParams.set(AID_PARAM, aid);
      a.href = u.toString();
    } catch (_) {}
  }, true /* capture */);

  document$.subscribe(function () {
    const deploymentId = getParam(DID_PARAM);
    const accountId = getParam(AID_PARAM);

    // Target code blocks and inline code only — don't rewrite prose or nav
    document.querySelectorAll("code, pre").forEach(function (el) {
      if (deploymentId && deploymentId !== DEPLOYMENT_PLACEHOLDER) {
        replaceInNode(el, DEPLOYMENT_PLACEHOLDER, deploymentId);
      }
      if (accountId && accountId !== ACCOUNT_PLACEHOLDER) {
        replaceInNode(el, ACCOUNT_PLACEHOLDER, accountId);
      }
    });

    // Rewrite placeholder values in anchor hrefs (e.g. console deep-links)
    document.querySelectorAll("a[href]").forEach(function (el) {
      let href = el.getAttribute("href");
      if (!href) return;
      if (deploymentId && deploymentId !== DEPLOYMENT_PLACEHOLDER) {
        href = href.replaceAll(DEPLOYMENT_PLACEHOLDER, deploymentId);
      }
      if (accountId && accountId !== ACCOUNT_PLACEHOLDER) {
        href = href.replaceAll(ACCOUNT_PLACEHOLDER, accountId);
      }
      el.setAttribute("href", href);
    });

    // Also update any "Your deployment ID" / "Your account ID" banners if present
    document.querySelectorAll("[data-deployment-id]").forEach(function (el) {
      if (deploymentId) el.textContent = deploymentId;
    });
    document.querySelectorAll("[data-account-id]").forEach(function (el) {
      if (accountId) el.textContent = accountId;
    });
  });
})();
