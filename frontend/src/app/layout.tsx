"use client";

import type { Metadata } from "next";
import { Amplify } from "aws-amplify";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import "./globals.css";

// Amplify config is loaded at build time from amplify_outputs.json. The slot's
// auth/data resources are now plain-CDK nested stacks (no `ampx sandbox`), so
// generate this file from the target slot's SSM params before `pnpm dev`:
//   scripts/gen-amplify-outputs.sh <ws-slotNN>
// (One file, one slot at a time — the frontend runs against a single slot.)
let amplifyConfig: Record<string, unknown> = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  amplifyConfig = require("../../amplify_outputs.json");
} catch {
  console.warn(
    "amplify_outputs.json not found — run `scripts/gen-amplify-outputs.sh <ws-slotNN>` first",
  );
}

if (Object.keys(amplifyConfig).length > 0) {
  Amplify.configure(amplifyConfig as any);
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Authenticator>
          {({ signOut, user }) => (
            <main>
              <nav className="navbar">
                <span className="navbar-title">Edge Digital Ops Workshop</span>
                <span className="navbar-user">{user?.signInDetails?.loginId}</span>
                <button onClick={signOut} className="navbar-signout">Sign out</button>
              </nav>
              {children}
            </main>
          )}
        </Authenticator>
      </body>
    </html>
  );
}
