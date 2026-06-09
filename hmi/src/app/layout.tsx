import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Edge HMI",
  description: "Industrial edge Human-Machine Interface",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <nav>
          <span className="brand">Edge HMI</span>
          <Link href="/">Site View</Link>
          <Link href="/ops">Digital Ops</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
