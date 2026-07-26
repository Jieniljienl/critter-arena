import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "电子斗蛐蛐 · Critter Arena Lab";
const description =
  "可自定义角色、动作、搞笑音效、棋盘范围和技能参数，并支持横竖屏纯净观战的全自动电子斗蛐蛐模拟器。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol =
    requestHeaders.get("x-forwarded-proto") ?? (host?.includes("localhost") ? "http" : "https");
  const origin = host ? `${protocol}://${host}` : "http://localhost:3000";
  const socialImage = new URL("/og.png", origin).toString();

  return {
    title,
    description,
    icons: { icon: "/icon.png", apple: "/icon.png" },
    openGraph: {
      title,
      description,
      type: "website",
      images: [
        {
          url: socialImage,
          width: 1200,
          height: 630,
          alt: "懒洋洋熊猫、人类警察和地鼠在竹林熔岩温泉竞技场对战",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
