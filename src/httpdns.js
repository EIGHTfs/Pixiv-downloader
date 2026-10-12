/**
 * HTTPDNS - 使用 Cloudflare DNS-over-HTTPS 解析 Pixiv 域名
 * 参考：Pixiv-Shaft (https://github.com/CeuiLiSA/Pixiv-Shaft)
 * 
 * 绕过 DNS 污染，获取真实 IP 直连 Pixiv API
 */

const https = require('https')
const { Agent } = require('https')

// Cloudflare DNS-over-HTTPS 端点
const DOH_ENDPOINTS = [
    'https://1.0.0.1/dns-query',
    'https://1.1.1.1/dns-query',
]

// Pixiv 域名列表
const PIXIV_DOMAINS = [
    'app-api.pixiv.net',
    'oauth.secure.pixiv.net',
    'www.pixiv.net',
]

// Cloudflare CDN IP（Pixiv API 已迁移到 CF）
const FALLBACK_CF_IPS = [
    '104.18.42.239',
    '172.64.145.17',
]

// 图片服务器旧 IP
const FALLBACK_IMAGE_IPS = [
    '210.140.139.134',
    '210.140.139.133',
    '210.140.139.131',
]

// 缓存解析结果
const resolvedHosts = {}

/**
 * 通过 DNS-over-HTTPS 解析域名
 */
function queryDnsOverHttps(hostname) {
    return new Promise((resolve, reject) => {
        const url = new URL(DOH_ENDPOINTS[0])
        url.searchParams.set('name', hostname)
        url.searchParams.set('type', 'A')

        const options = {
            hostname: '1.0.0.1',
            port: 443,
            path: `/dns-query?name=${hostname}&type=A`,
            method: 'GET',
            headers: {
                'Accept': 'application/dns-json',
                'User-Agent': 'pxrepo-httpdns/1.0'
            }
        }

        const req = https.request(options, (res) => {
            let data = ''
            res.on('data', chunk => data += chunk)
            res.on('end', () => {
                try {
                    const json = JSON.parse(data)
                    if (json.Answer) {
                        const ips = json.Answer
                            .filter(r => r.type === 1) // A 记录
                            .map(r => r.data)
                        resolve(ips)
                    } else {
                        resolve(null)
                    }
                } catch (e) {
                    resolve(null)
                }
            })
        })

        req.on('error', reject)
        req.setTimeout(3000, () => {
            req.destroy()
            resolve(null)
        })
        req.end()
    })
}

/**
 * 解析域名，优先使用 HTTPDNS
 */
async function resolveHostname(hostname, useHttpDns = true) {
    // 如果是 IP 地址，直接返回
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        return [hostname]
    }

    // 检查缓存
    if (resolvedHosts[hostname]) {
        return resolvedHosts[hostname]
    }

    let ips = null

    // 尝试 HTTPDNS
    if (useHttpDns) {
        try {
            console.log(`[HTTPDNS] 解析 ${hostname}...`)
            ips = await queryDnsOverHttps(hostname)
            if (ips && ips.length > 0) {
                console.log(`[HTTPDNS] ${hostname} -> ${ips.join(', ')}`)
                resolvedHosts[hostname] = ips
                return ips
            }
        } catch (e) {
            console.error(`[HTTPDNS] 解析 ${hostname} 失败:`, e.message)
        }
    }

    // 使用系统 DNS 作为备选
    try {
        const dns = require('dns')
        return new Promise((resolve, reject) => {
            dns.lookup(hostname, { all: true }, (err, addresses) => {
                if (err) {
                    // 使用备用 IP
                    const fallback = isImageDomain(hostname) ? FALLBACK_IMAGE_IPS : FALLBACK_CF_IPS
                    console.log(`[HTTPDNS] 系统 DNS 失败，使用备用 IP: ${fallback.join(', ')}`)
                    resolve(fallback)
                } else {
                    const ips = addresses.map(a => a.address)
                    console.log(`[HTTPDNS] ${hostname} (系统DNS) -> ${ips.join(', ')}`)
                    resolvedHosts[hostname] = ips
                    resolve(ips)
                }
            })
        })
    } catch (e) {
        // 最终回退到硬编码 IP
        const fallback = isImageDomain(hostname) ? FALLBACK_IMAGE_IPS : FALLBACK_CF_IPS
        console.log(`[HTTPDNS] 使用备用 IP: ${fallback.join(', ')}`)
        resolvedHosts[hostname] = fallback
        return fallback
    }
}

/**
 * 判断是否为图片域名
 */
function isImageDomain(hostname) {
    return hostname.endsWith('pximg.net') || hostname.includes('i.pximg')
}

/**
 * 预热 DNS 缓存
 */
async function warmupCache() {
    console.log('[HTTPDNS] 预热 DNS 缓存...')
    for (const domain of PIXIV_DOMAINS) {
        try {
            await resolveHostname(domain)
        } catch (e) {
            console.error(`[HTTPDNS] 预热 ${domain} 失败:`, e.message)
        }
    }
}

/**
 * 获取 Pixiv API 的代理 Agent（直连模式）
 * @param {string} hostname - 目标主机名
 * @param {string} ip - 解析得到的 IP
 * @returns {Agent} HTTPS Agent
 */
function createDirectAgent(hostname, ip) {
    return new Agent({
        rejectUnauthorized: false,
        servername: hostname,
        host: ip,
    })
}

/**
 * 修改 axios 请求，使用 HTTPDNS 解析的 IP
 * @param {object} axiosInstance - axios 实例
 * @param {string} hostname - 目标主机名
 */
async function applyHttpDns(axiosInstance, hostname) {
    const ips = await resolveHostname(hostname)
    if (ips && ips.length > 0) {
        const ip = ips[0]
        // 修改请求的 hostname 为解析到的 IP
        axiosInstance.defaults.headers.common['Host'] = hostname
        return ip
    }
    return null
}

module.exports = {
    resolveHostname,
    warmupCache,
    isImageDomain,
    createDirectAgent,
    applyHttpDns,
    FALLBACK_CF_IPS,
    FALLBACK_IMAGE_IPS,
}
