# Nginx SSL 证书配置说明

## 概述

本项目使用 Let's Encrypt 免费 SSL 证书，通过 Certbot 自动管理。

## 服务器信息

- **VPS IP**: `23.94.99.235`
- **域名**: `hao123456.cn`
- **子域名**: `blog.hao123456.cn`
- **网站目录**: `/var/www/refine-blog-frontend`

## Nginx 配置文件

位置: `/etc/nginx/sites-available/hao123456.cn`

```nginx
server {
    server_name hao123456.cn blog.hao123456.cn;
    root /var/www/refine-blog-frontend;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/hao123456.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hao123456.cn/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

# HTTP → HTTPS 重定向
server {
    listen 80;
    server_name hao123456.cn blog.hao123456.cn;
    return 301 https://$host$request_uri;
}
```

## 证书文件位置

```
/etc/letsencrypt/
├── live/
│   └── hao123456.cn/
│       ├── fullchain.pem    # 完整证书链
│       ├── privkey.pem      # 私钥
│       ├── cert.pem         # 服务器证书
│       └── chain.pem        # 中间证书
├── archive/                 # 所有历史证书
└── renewal/                 # 续期配置
```

## 常用命令

### 1. 申请/更新证书

```bash
# 单域名
certbot --nginx -d hao123456.cn

# 多域名（同时覆盖子域名）
certbot --nginx -d hao123456.cn -d blog.hao123456.cn --expand

# 测试续期
certbot renew --dry-run
```

### 2. 查看证书信息

```bash
# 查看证书到期时间
certbot certificates

# 查看证书详情
openssl s_client -connect hao123456.cn:443 -servername hao123456.cn </dev/null 2>/dev/null | openssl x509 -noout -dates
```

### 3. Nginx 操作

```bash
# 测试配置
nginx -t

# 重载配置
nginx -s reload

# 重启服务
systemctl restart nginx
```

## 证书自动续期

Let's Encrypt 证书有效期 90 天，Certbot 自动安排续期任务。

```bash
# 查看续期定时器
systemctl status certbot.timer

# 查看续期日志
cat /var/log/letsencrypt/letsencrypt.log
```

## Cloudflare SSL 设置

### 推荐模式: Full (Strict)

```
SSL/TLS → 概览 → Full (Strict)

Cloudflare 验证 VPS 证书来自可信 CA
```

### 各模式区别

| 模式 | 加密 | 证书验证 | 推荐 |
|------|------|----------|------|
| Off | ❌ | 无 | 不推荐 |
| Flexible | ✅ | ❌ | 测试用 |
| Full | ✅ | ❌ | 不验证来源 |
| **Full (Strict)** | ✅ | ✅ | **推荐** |

## DNS 配置

| 类型 | 名称 | 内容 | 代理 |
|------|------|------|------|
| A | @ | 23.94.99.235 | 已代理 |
| A | blog | 23.94.99.235 | 已代理 |

## 故障排查

### 1. 526 错误（Cloudflare 无法验证证书）

```bash
# 1. 确认证书存在
ls -la /etc/letsencrypt/live/hao123456.cn/

# 2. 测试本地 HTTPS
curl -k https://localhost

# 3. 重新部署证书
certbot --nginx -d hao123456.cn -d blog.hao123456.cn --expand
```

### 2. 443 端口被占用

```bash
# 查看占用 443 端口的进程
ss -tlnp | grep :443

# 常见冲突服务: xray, apache, nginx 多实例
```

### 3. 证书续期失败

```bash
# 查看详细错误
tail -50 /var/log/letsencrypt/letsencrypt.log

# 手动续期测试
certbot renew --force-renewal
```

## 安全注意事项

1. **私钥权限**: `/etc/letsencrypt/live/hao123456.cn/privkey.pem` 应为 600
2. **不要提交证书**: 证书文件不应放入 Git
3. **定期备份**: 建议备份 `/etc/letsencrypt/` 目录

```bash
# 设置私钥权限
chmod 600 /etc/letsencrypt/live/hao123456.cn/privkey.pem

# 备份证书
tar -czf letsencrypt-backup.tar.gz /etc/letsencrypt/
```
