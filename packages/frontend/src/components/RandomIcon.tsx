"use client";

import { useEffect } from "react";

const CATS = [
  "橘猫", "美短", "蓝猫", "布偶", "黑猫", "黄猫", "牛奶猫", "缅因猫",
  "无毛猫", "狸花猫", "三花猫", "田园猫", "英短猫", "暹罗猫", "波斯猫",
  "白猫", "傻猫", "眯眯眼猫", "猫", "博学猫",
] as const;

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export default function RandomIcon() {
  useEffect(() => {
    const cat = pickRandom(CATS);
    const href = `/icons/${cat}.svg`;

    const setLink = (rel: string, sizes?: string) => {
      let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      if (!link) {
        link = document.createElement("link");
        link.rel = rel;
        if (sizes) link.setAttribute("sizes", sizes);
        document.head.appendChild(link);
      }
      link.href = href;
      link.type = "image/svg+xml";
    };

    setLink("icon", "any");
    setLink("apple-touch-icon");
  }, []);

  return null;
}
