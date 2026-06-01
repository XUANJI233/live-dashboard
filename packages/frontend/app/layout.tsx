import type { Metadata, Viewport } from "next";
import "./globals.css";
import PwaRegistrar from "@/components/PwaRegistrar";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#f97316",
};

export const metadata: Metadata = {
  title: "Monika 现在在做什么",
  description: "轻轻看一眼 Monika 此刻的动态",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Live Dashboard",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <PwaRegistrar />
        <div className="app-shell">
          {children}
        </div>
      </body>
    </html>
  );
}
