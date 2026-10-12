'use strict';
/**
 * src/net/limiter.js —— 全局限速与延时工具（零依赖）
 *
 * 为什么需要：Pixiv API 与图片 CDN 都会对高频请求返回 429；
 * 用令牌桶把「每秒请求数」压到配置值（PXREPO_TPS，0 = 不限速），API 与下载共用同一实例。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 令牌桶式限速器（按固定间隔放行，避免瞬时突发）
 * @param {number} tps 每秒请求数；<=0 表示不限速
 * @returns {{wait:()=>Promise<void>, intervalMs:number}}
 */
function createRateLimiter(tps) {
  const rate = Number(tps) || 0;
  if (rate <= 0) return { wait: async () => {}, intervalMs: 0 };
  const intervalMs = 1000 / rate;
  let nextAllowed = 0;
  return {
    intervalMs,
    wait: async () => {
      const now = Date.now();
      const at = Math.max(now, nextAllowed); // 并发调用时各自排到下一个时间片
      nextAllowed = at + intervalMs;
      const delay = at - now;
      if (delay > 0) await sleep(delay);
    },
  };
}

module.exports = { createRateLimiter, sleep };
