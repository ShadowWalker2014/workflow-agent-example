import type { Metadata } from "next";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "Workflow Agent Example",
  description: "Durable resumable AI chat with Vercel AI SDK + Workflow DevKit",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
