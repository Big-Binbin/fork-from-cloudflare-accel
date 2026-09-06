// 注意: 本文件是 EdgeOne Pages 的部署入口(edge-functions catch-all), 与根目录 _worker.js 逻辑一致
// 更新日期: 2026-09-05
// 更新内容:
// 1. 回源请求增加超时与重试（fetchWithRetry）：单次回源最多等 10s，GET/HEAD 失败自动重试，
//    解决 EdgeOne 大陆节点回源 GitHub 偶发跨境抖动导致的间歇性 504
// 2. 新增边缘缓存：GET 的 200 响应写入 caches.default，TTL 跟随上游 Cache-Control，
//    热点文件命中缓存直接返回，不再回源
// 3. 回源超时显式返回 504（AbortError），与普通错误 500 区分，便于排查
// 历史更新（2026-08-22）:
// 1. Docker 镜像层重定向改为循环跟随（最多 5 次），支持 CDN 多级跳转，提升拉取成功率
// 2. 新增 OPTIONS 预检请求处理，修复 CORS 预检被当作代理请求的问题
// 3. 首页移除 cdn.tailwindcss.com 依赖，改为内联 CSS，国内访问不再被外链阻塞
// 4. 前端支持 http:// 开头的链接输入，与后端能力对齐
// 5. 首页增加 Cache-Control 缓存头，命中边缘缓存
// 6. RESTRICT_PATHS 路径检查改用提取后的目标路径（原先误用含域名前缀的原始路径）
// 7. 移除所有日志输出与死代码，公共常量提升到模块顶层，减少每请求开销
// 用户配置区域开始 =================================
// 以下变量用于配置代理服务的白名单和安全设置，可根据需求修改。

// ALLOWED_HOSTS: 定义允许代理的域名列表（默认白名单）。
// - 添加新域名：将域名字符串加入数组，如 'docker.io'。
// - 注意：仅支持精确匹配的域名（如 'github.com'），不支持通配符。
// - 只有列出的域名会被处理，未列出的域名将返回 400 错误。
// 示例：const ALLOWED_HOSTS = ['github.com', 'docker.io'];
const ALLOWED_HOSTS = [
  'quay.io',
  'gcr.io',
  'k8s.gcr.io',
  'registry.k8s.io',
  'ghcr.io',
  'docker.cloudsmith.io',
  'registry-1.docker.io',
  'index.docker.io',
  'production.cloudflare.docker.com',
  'docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'media.githubusercontent.com',
  'avatars.githubusercontent.com',
  'camo.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'user-images.githubusercontent.com',
  'cloud.githubusercontent.com',
  'github-production-user-asset-6210df.s3.amazonaws.com',
  'github-production-release-asset-2e65be.s3.amazonaws.com',
  'gitlab.com',
  'gitlab.freedesktop.org',
  'gitlab.gnome.org',
  'gitlab.kitware.com',
  'gitlab.archlinux.org',
  'gitlab.postmarketos.org'
];

// RESTRICT_PATHS: 控制是否限制 GitHub 和 Docker 请求的路径。
// - 设置为 true：只允许 ALLOWED_PATHS 中定义的路径关键字。
// - 设置为 false：允许 ALLOWED_HOSTS 中的所有路径。
// 示例：const RESTRICT_PATHS = true;
const RESTRICT_PATHS = false;

// ALLOWED_PATHS: 定义 GitHub 和 Docker 的允许路径关键字。
// - 添加新关键字：加入数组，如 'user-id-3' 或 'my-repo'。
// - 用于匹配请求路径（如 'library' 用于 Docker Hub 官方镜像）。
// - 路径检查对大小写不敏感，仅当 RESTRICT_PATHS = true 时生效。
// 示例：const ALLOWED_PATHS = ['library', 'my-user', 'my-repo'];
const ALLOWED_PATHS = [
  'library',   // Docker Hub 官方镜像仓库的命名空间
  'user-id-1',
  'user-id-2',
];

// 用户配置区域结束 =================================

// Docker 镜像仓库域名列表（模块级常量，避免每个请求重复创建）
const DOCKER_REGISTRY_HOSTS = [
  'quay.io',
  'gcr.io',
  'k8s.gcr.io',
  'registry.k8s.io',
  'ghcr.io',
  'docker.cloudsmith.io',
  'registry-1.docker.io',
  'index.docker.io',
  'production.cloudflare.docker.com'
];

// Git 托管平台域名列表（模块级常量，避免每个请求重复创建）
const GIT_HOSTS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com',
  'gitlab.com',
  'gitlab.freedesktop.org',
  'gitlab.gnome.org',
  'gitlab.kitware.com',
  'gitlab.archlinux.org',
  'gitlab.postmarketos.org'
];

// Docker 镜像层重定向最大跟随次数（CDN 多级跳转保护）
const MAX_REDIRECTS = 5;

// 闪电 SVG 图标（Base64 编码）
const LIGHTNING_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
</svg>`;

// 首页 HTML（样式全部内联，不依赖任何外部 CDN）
const HOMEPAGE_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EdgeOne 加速</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(LIGHTNING_SVG)}">
  <style>
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Inter', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      transition: background-color 0.3s, color 0.3s;
      padding: 1rem;
      margin: 0;
    }
    .light-mode {
      background: linear-gradient(to bottom right, #f1f5f9, #e2e8f0);
      color: #111827;
    }
    .dark-mode {
      background: linear-gradient(to bottom right, #1f2937, #374151);
      color: #e5e7eb;
    }
    .container {
      width: 100%;
      max-width: 800px;
      margin: 0 auto;
      padding: 1.5rem;
      border-radius: 0.75rem;
      border: 1px solid #e5e7eb;
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.1);
    }
    .light-mode .container {
      background: #ffffff;
    }
    .dark-mode .container {
      background: #1f2937;
      border-color: #374151;
    }
    .section-box {
      background: linear-gradient(to bottom, #ffffff, #f3f4f6);
      border-radius: 0.5rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
    }
    .dark-mode .section-box {
      background: linear-gradient(to bottom, #374151, #1f2937);
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    }
    h1 {
      font-size: 1.875rem;
      font-weight: 700;
      text-align: center;
      margin: 0 0 2rem 0;
    }
    h2 {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0 0 0.5rem 0;
    }
    p {
      color: #4b5563;
      margin: 0 0 1rem 0;
    }
    .dark-mode p {
      color: #d1d5db;
    }
    .theme-toggle {
      position: fixed;
      top: 0.5rem;
      right: 0.5rem;
      padding: 0.5rem;
      font-size: 1.2rem;
      border: none;
      cursor: pointer;
      background: #e5e7eb;
      color: #1f2937;
      border-radius: 9999px;
      transition: background-color 0.2s;
    }
    .theme-toggle:hover {
      background: #d1d5db;
    }
    .dark-mode .theme-toggle {
      background: #374151;
      color: #e5e7eb;
    }
    .dark-mode .theme-toggle:hover {
      background: #4b5563;
    }
    .toast {
      position: fixed;
      bottom: 1rem;
      left: 50%;
      transform: translateX(-50%);
      background: #10b981;
      color: white;
      padding: 0.75rem 1.5rem;
      border-radius: 0.5rem;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      opacity: 0;
      transition: opacity 0.3s;
      font-size: 0.9rem;
      max-width: 90%;
      text-align: center;
    }
    .toast.show {
      opacity: 1;
    }
    .result-text {
      word-break: break-all;
      overflow-wrap: break-word;
      font-size: 0.95rem;
      max-width: 100%;
      padding: 0.5rem;
      border-radius: 0.25rem;
      background: #f3f4f6;
      color: #059669;
      margin: 0.5rem 0 0 0;
    }
    .dark-mode .result-text {
      background: #2d3748;
      color: #34d399;
    }
    .input-row {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    input[type="text"] {
      flex-grow: 1;
      padding: 0.5rem;
      border: 1px solid #9ca3af;
      border-radius: 0.5rem;
      outline: none;
      background: #ffffff;
      color: #111827;
      font-size: 1rem;
    }
    input[type="text"]::placeholder {
      color: #9ca3af;
    }
    input[type="text"]:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.5);
    }
    .dark-mode input[type="text"] {
      background: #374151;
      color: #e5e7eb;
      border-color: #4b5563;
    }
    .dark-mode input[type="text"]::placeholder {
      color: #6b7280;
    }
    .btn {
      border: none;
      cursor: pointer;
      border-radius: 0.5rem;
      transition: background-color 0.2s;
      font-size: 1rem;
    }
    .btn-primary {
      background: #3b82f6;
      color: #ffffff;
      padding: 0.5rem 1rem;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .btn-primary:hover {
      background: #2563eb;
    }
    .btn-secondary {
      background: #e5e7eb;
      color: #1f2937;
      padding: 0.25rem 0.75rem;
      width: 100%;
    }
    .btn-secondary:hover {
      background: #d1d5db;
    }
    .dark-mode .btn-secondary {
      background: #4b5563;
      color: #e5e7eb;
    }
    .dark-mode .btn-secondary:hover {
      background: #6b7280;
    }
    .btn-row {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    .hidden {
      display: none;
    }

    @media (max-width: 640px) {
      .container {
        padding: 1rem;
      }
      .section-box {
        padding: 1rem;
        margin-bottom: 1rem;
      }
      h1 {
        font-size: 1.5rem;
        margin-bottom: 1.5rem;
      }
      h2 {
        font-size: 1.25rem;
        margin-bottom: 0.75rem;
      }
      p {
        font-size: 0.875rem;
      }
      input {
        font-size: 0.875rem;
        padding: 0.5rem;
        min-height: 44px;
      }
      button {
        font-size: 0.875rem;
        padding: 0.5rem 1rem;
        min-height: 44px;
      }
      .input-row {
        flex-direction: column;
        gap: 0.5rem;
      }
      .btn-row {
        flex-direction: column;
        gap: 0.5rem;
      }
      .result-text {
        font-size: 0.8rem;
        padding: 0.4rem;
      }
    }
  </style>
</head>
<body class="light-mode">
  <button onclick="toggleTheme()" class="theme-toggle">
    <span class="sun">☀️</span>
    <span class="moon hidden">🌙</span>
  </button>
  <div class="container">
    <h1>EdgeOne 加速下载</h1>

    <!-- GitHub 链接转换 -->
    <div class="section-box">
      <h2>⚡ GitHub 文件加速 / Git Clone</h2>
      <p>输入 GitHub 文件链接获取加速链接；输入以 .git 结尾的仓库地址则自动生成 git clone 加速命令。</p>
      <div class="input-row">
        <input
          id="github-url"
          type="text"
          placeholder="请输入 GitHub 文件链接或 .git 仓库地址，例如：https://github.com/user/repo/releases/..."
        >
        <button
          id="github-submit-btn"
          onclick="convertGithubUrl()"
          class="btn btn-primary"
        >
          获取加速链接
        </button>
      </div>
      <p id="github-result" class="result-text hidden"></p>
      <div id="github-buttons" class="btn-row hidden">
        <button onclick="copyGithubUrl()" class="btn btn-secondary">📋 复制</button>
        <button onclick="openGithubUrl()" class="btn btn-secondary">🔗 打开链接</button>
      </div>
    </div>

    <!-- Docker 镜像加速 -->
    <div class="section-box">
      <h2>🐳 Docker 镜像加速</h2>
      <p>输入原镜像地址（如 hello-world 或 ghcr.io/user/repo），获取加速拉取命令。</p>
      <div class="input-row">
        <input
          id="docker-image"
          type="text"
          placeholder="请输入镜像地址，例如：hello-world 或 ghcr.io/user/repo"
        >
        <button
          onclick="convertDockerImage()"
          class="btn btn-primary"
        >
          获取加速命令
        </button>
      </div>
      <p id="docker-result" class="result-text hidden"></p>
      <div id="docker-buttons" class="btn-row hidden">
        <button onclick="copyDockerCommand()" class="btn btn-secondary">📋 复制命令</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    // 动态获取当前域名
    const currentDomain = window.location.hostname;

    // 主题切换
    function toggleTheme() {
      const body = document.body;
      const sun = document.querySelector('.sun');
      const moon = document.querySelector('.moon');
      if (body.classList.contains('light-mode')) {
        body.classList.remove('light-mode');
        body.classList.add('dark-mode');
        sun.classList.add('hidden');
        moon.classList.remove('hidden');
        localStorage.setItem('theme', 'dark');
      } else {
        body.classList.remove('dark-mode');
        body.classList.add('light-mode');
        moon.classList.add('hidden');
        sun.classList.remove('hidden');
        localStorage.setItem('theme', 'light');
      }
    }

    // 初始化主题
    if (localStorage.getItem('theme') === 'dark') {
      toggleTheme();
    }

    // 显示弹窗提示
    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      // 错误提示红色，成功提示绿色
      toast.style.background = isError ? '#ef4444' : '#10b981';
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 3000);
    }

    // 复制文本的通用函数
    function copyToClipboard(text) {
      // 尝试使用 navigator.clipboard API
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).catch(err => {
          console.error('Clipboard API failed:', err);
          return false;
        });
      }
      // 后备方案：使用 document.execCommand
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        return successful ? Promise.resolve() : Promise.reject(new Error('Copy command failed'));
      } catch (err) {
        document.body.removeChild(textarea);
        return Promise.reject(err);
      }
    }

    // GitHub 链接转换
    let githubAcceleratedUrl = '';
    let githubIsGitMode = false;
    function convertGithubUrl() {
      const input = document.getElementById('github-url').value.trim();
      const result = document.getElementById('github-result');
      const buttons = document.getElementById('github-buttons');
      const submitBtn = document.getElementById('github-submit-btn');
      const copyBtn = buttons.children[0];
      const openBtn = buttons.children[1];
      if (!input) {
        showToast('请输入有效的链接', true);
        result.classList.add('hidden');
        buttons.classList.add('hidden');
        return;
      }
      // 同时支持 https:// 和 http:// 开头的链接
      const schemeMatch = input.match(/^(https?):\\/\\//);
      if (!schemeMatch) {
        showToast('链接必须以 http:// 或 https:// 开头', true);
        result.classList.add('hidden');
        buttons.classList.add('hidden');
        return;
      }
      const rest = input.substring(schemeMatch[0].length);

      // 检测是否以 .git 结尾，如果是则输出 git clone 指令
      if (input.endsWith('.git')) {
        githubIsGitMode = true;
        submitBtn.textContent = '获取加速命令';
        githubAcceleratedUrl = 'git clone https://' + currentDomain + '/' + schemeMatch[0] + rest;
        result.textContent = '加速命令: ' + githubAcceleratedUrl;
        result.classList.remove('hidden');
        buttons.classList.remove('hidden');
        copyBtn.textContent = '📋 复制命令';
        // .git 模式隐藏"打开链接"按钮
        if (openBtn) openBtn.classList.add('hidden');
        copyToClipboard(githubAcceleratedUrl).then(() => {
          showToast('已复制到剪贴板');
        }).catch(err => {
          showToast('复制失败: ' + err.message, true);
        });
        return;
      }

      githubIsGitMode = false;
      submitBtn.textContent = '获取加速链接';
      // 保持现有格式：域名/https://原始链接
      githubAcceleratedUrl = 'https://' + currentDomain + '/' + schemeMatch[0] + rest;
      result.textContent = '加速链接: ' + githubAcceleratedUrl;
      result.classList.remove('hidden');
      buttons.classList.remove('hidden');
      copyBtn.textContent = '📋 复制链接';
      // 正常模式显示"打开链接"按钮
      if (openBtn) openBtn.classList.remove('hidden');
      copyToClipboard(githubAcceleratedUrl).then(() => {
        showToast('已复制到剪贴板');
      }).catch(err => {
        showToast('复制失败: ' + err.message, true);
      });
    }

    function copyGithubUrl() {
      copyToClipboard(githubAcceleratedUrl).then(() => {
        showToast('已复制到剪贴板');
      }).catch(err => {
        showToast('复制失败: ' + err.message, true);
      });
    }

    function openGithubUrl() {
      if (!githubIsGitMode) {
        window.open(githubAcceleratedUrl, '_blank');
      }
    }

    // Docker 镜像转换
    let dockerCommand = '';
    function convertDockerImage() {
      const input = document.getElementById('docker-image').value.trim();
      const result = document.getElementById('docker-result');
      const buttons = document.getElementById('docker-buttons');
      if (!input) {
        showToast('请输入有效的镜像地址', true);
        result.classList.add('hidden');
        buttons.classList.add('hidden');
        return;
      }
      dockerCommand = 'docker pull ' + currentDomain + '/' + input;
      result.textContent = '加速命令: ' + dockerCommand;
      result.classList.remove('hidden');
      buttons.classList.remove('hidden');
      copyToClipboard(dockerCommand).then(() => {
        showToast('已复制到剪贴板');
      }).catch(err => {
        showToast('复制失败: ' + err.message, true);
      });
    }

    function copyDockerCommand() {
      copyToClipboard(dockerCommand).then(() => {
        showToast('已手动复制到剪贴板');
      }).catch(err => {
        showToast('手动复制失败: ' + err.message, true);
      });
    }
  </script>
</body>
</html>
`;

// 获取 Docker registry 的匿名 token
// 参数：realm 认证地址 / service 服务名 / scope 资源范围；返回 token 字符串或 null
async function handleToken(realm, service, scope) {
  const tokenUrl = realm + '?service=' + service + '&scope=' + scope;
  try {
    const tokenResponse = await fetch(tokenUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (!tokenResponse.ok) {
      return null;
    }
    const tokenData = await tokenResponse.json();
    return tokenData.token || tokenData.access_token || null;
  } catch (error) {
    return null;
  }
}

// 判断 URL 是否指向 AWS S3（用于补全 x-amz 签名头）
function isAmazonS3(url) {
  try {
    return new URL(url).hostname.includes('amazonaws.com');
  } catch {
    return false;
  }
}

// 生成 AWS S3 要求的 x-amz-date 时间戳（格式：YYYYMMDDTHHMMSSZ）
function getAmzDate() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5) + 'Z';
}

// 获取空请求体的 SHA256 哈希值（S3 匿名请求固定值）
function getEmptyBodySHA256() {
  return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
}

// 检测是否为 Git smart-http 协议请求
function isGitRequest(request, targetDomain) {
  // 检查 User-Agent 是否包含 git/
  const ua = request.headers.get('User-Agent') || '';
  if (ua.toLowerCase().includes('git/')) {
    return true;
  }
  // 检查目标域名是否为 Git 托管平台
  if (GIT_HOSTS.includes(targetDomain)) {
    const url = new URL(request.url);
    const path = url.pathname;
    // Git smart-http 使用 /info/refs?service=git-upload-pack 或 /git-upload-pack
    if (path.includes('/info/refs') || path.includes('/git-upload-pack') || path.includes('/git-receive-pack')) {
      return true;
    }
    // 路径包含 .git 也可能是 Git 请求（如 /user/repo.git/...）
    if (path.includes('.git')) {
      return true;
    }
  }
  return false;
}

// 为 Git 请求构建正确的代理请求头
function buildGitHeaders(request, targetDomain) {
  const headers = new Headers(request.headers);

  // 设置正确的 Host
  headers.set('Host', targetDomain);

  // 删除可能干扰 Git 协议的头部
  headers.delete('Cookie');
  headers.delete('CF-Connecting-IP');
  headers.delete('CF-IPCountry');
  headers.delete('CF-Ray');
  headers.delete('CF-Visitor');
  headers.delete('CF-Worker');
  headers.delete('X-Forwarded-For');
  headers.delete('X-Real-IP');
  headers.delete('X-Forwarded-Proto');
  headers.delete('X-Forwarded-Host');

  // 删除 AWS S3 相关头部（不相关）
  headers.delete('x-amz-content-sha256');
  headers.delete('x-amz-date');
  headers.delete('x-amz-security-token');
  headers.delete('x-amz-user-agent');

  return headers;
}

// 带超时与重试的回源请求
// 背景：EdgeOne 大陆节点回源 GitHub 偶发跨境抖动，单次裸 fetch 变慢会被边缘函数
// 约 15s 的执行时限掐断，用户侧表现为间歇性 504。
// - 每次尝试最多等 10s，超时即放弃本次尝试，为重试留出时间；
// - 仅对 GET/HEAD（无请求体、幂等）自动重试；POST 等带流式请求体的方法重试会导致
//   body 已被消费，保持原单次行为；
// - 参数 url: 上游完整地址；options: 传给 fetch 的配置；maxRetries: 最大尝试次数。
// - 返回值: 上游 Response；全部尝试失败时抛出最后一次异常。
async function fetchWithRetry(url, options, maxRetries) {
  const method = (options.method || 'GET').toUpperCase();
  const canRetry = method === 'GET' || method === 'HEAD';
  const attempts = canRetry ? Math.max(1, maxRetries) : 1;
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      // 上游 5xx/429 视为本次失败，若还有机会则换一次尝试
      if (canRetry && (response.status >= 500 || response.status === 429) && i < attempts - 1) {
        lastError = new Error('upstream status ' + response.status);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (i >= attempts - 1) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function handleRequest(request) {
  const url = new URL(request.url);
  let path = url.pathname;

  // 首页路由（带缓存头，命中边缘缓存）
  if (path === '/' || path === '') {
    return new Response(HOMEPAGE_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  }

  // CORS 预检请求直接放行，不进入代理逻辑
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  // 处理 Docker V2 API 或 GitHub 代理请求
  let isV2Request = false;
  let v2RequestType = null; // 'manifests' 或 'blobs'
  let v2RequestTag = null;  // tag 或 digest
  if (path.startsWith('/v2/')) {
    isV2Request = true;
    path = path.replace('/v2/', '');

    // 解析 V2 API 请求类型和标签/摘要
    const pathSegments = path.split('/').filter(part => part);
    if (pathSegments.length >= 3) {
      // 格式如: nginx/manifests/latest 或 nginx/blobs/sha256:xxx
      v2RequestType = pathSegments[pathSegments.length - 2];
      v2RequestTag = pathSegments[pathSegments.length - 1];
      // 提取镜像名称部分（去掉 manifests/tag 或 blobs/digest 部分）
      path = pathSegments.slice(0, pathSegments.length - 2).join('/');
    }
  }

  // 提取目标域名和路径
  const pathParts = path.split('/').filter(part => part);
  if (pathParts.length < 1) {
    return new Response('Invalid request: target domain or path required\n', { status: 400 });
  }

  let targetDomain, targetPath, isDockerRequest = false;

  // 检查路径是否以 https:// 或 http:// 开头
  // 注意：需要包含原始请求的查询参数（如 ?service=git-upload-pack），否则会丢失
  const fullPath = (path.startsWith('/') ? path.substring(1) : path) + url.search;

  if (fullPath.startsWith('https://') || fullPath.startsWith('http://')) {
    // 处理 /https://domain.com/... 或 /http://domain.com/... 格式
    const urlObj = new URL(fullPath);
    targetDomain = urlObj.hostname;
    targetPath = urlObj.pathname.substring(1) + url.search; // 移除开头的斜杠

    // 检查是否为 Docker 请求
    isDockerRequest = DOCKER_REGISTRY_HOSTS.includes(targetDomain) || targetDomain === 'docker.io';

    // 处理 docker.io 系域名，转换为 registry-1.docker.io（新版 V2 API 端点）
    if (targetDomain === 'docker.io' || targetDomain === 'index.docker.io') {
      targetDomain = 'registry-1.docker.io';
    }
  } else {
    // 处理 Docker 镜像路径的多种格式
    if (pathParts[0] === 'docker.io') {
      // 处理 docker.io/library/nginx 或 docker.io/amilys/embyserver 格式
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';

      if (pathParts.length === 2) {
        // 处理 docker.io/nginx 格式，添加 library 命名空间
        targetPath = 'library/' + pathParts[1];
      } else {
        // 处理 docker.io/amilys/embyserver 或 docker.io/library/nginx 格式
        targetPath = pathParts.slice(1).join('/');
      }
    } else if (ALLOWED_HOSTS.includes(pathParts[0])) {
      // Docker 镜像仓库（如 ghcr.io）或 GitHub 域名（如 github.com）
      targetDomain = pathParts[0];
      targetPath = pathParts.slice(1).join('/') + url.search;
      isDockerRequest = DOCKER_REGISTRY_HOSTS.includes(targetDomain);
    } else if (pathParts.length >= 1 && pathParts[0] === 'library') {
      // 处理 library/nginx 格式
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.join('/');
    } else if (pathParts.length >= 2) {
      // 处理 amilys/embyserver 格式（带命名空间但不是 library）
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.join('/');
    } else {
      // 处理单个镜像名称，如 nginx
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = 'library/' + pathParts.join('/');
    }
  }

  // 默认白名单检查：只允许 ALLOWED_HOSTS 中的域名
  if (!ALLOWED_HOSTS.includes(targetDomain)) {
    return new Response('Error: Invalid target domain.\n', { status: 400 });
  }

  // 路径白名单检查（仅当 RESTRICT_PATHS = true 时生效）
  if (RESTRICT_PATHS) {
    const isPathAllowed = ALLOWED_PATHS.some(pathString =>
      targetPath.toLowerCase().includes(pathString.toLowerCase())
    );
    if (!isPathAllowed) {
      return new Response('Error: The path is not in the allowed paths.\n', { status: 403 });
    }
  }

  // 构建目标 URL
  let targetUrl;
  if (isDockerRequest) {
    if (isV2Request && v2RequestType && v2RequestTag) {
      // 重构 V2 API URL
      targetUrl = 'https://' + targetDomain + '/v2/' + targetPath + '/' + v2RequestType + '/' + v2RequestTag;
    } else {
      targetUrl = 'https://' + targetDomain + '/' + (isV2Request ? 'v2/' : '') + targetPath;
    }
  } else {
    targetUrl = 'https://' + targetDomain + '/' + targetPath;
  }

  // 检测是否为 Git smart-http 请求
  const isGit = isGitRequest(request, targetDomain);

  let newRequestHeaders;
  if (isGit) {
    // Git 请求：使用白名单方式保留关键头部，避免 Cloudflare 添加的额外头部干扰 Git 协议
    newRequestHeaders = buildGitHeaders(request, targetDomain);
  } else {
    newRequestHeaders = new Headers(request.headers);
    newRequestHeaders.set('Host', targetDomain);
    newRequestHeaders.delete('Cookie');
    newRequestHeaders.delete('x-amz-content-sha256');
    newRequestHeaders.delete('x-amz-date');
    newRequestHeaders.delete('x-amz-security-token');
    newRequestHeaders.delete('x-amz-user-agent');

    if (isAmazonS3(targetUrl)) {
      newRequestHeaders.set('x-amz-content-sha256', getEmptyBodySHA256());
      newRequestHeaders.set('x-amz-date', getAmzDate());
    }
  }

  try {
    // Git 请求使用 follow 重定向，让 Cloudflare 自动跟随重定向
    // 非 Git 请求使用 manual 重定向以便拦截 307 并自己请求 S3
    const redirectMode = isGit ? 'follow' : 'manual';

    // 边缘缓存：仅对 GET 生效，命中直接返回，绕开跨境回源抖动；
    // caches 在部分运行时可能不可用，包 try 保证不影响主流程
    const edgeCache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
    if (edgeCache && request.method === 'GET') {
      try {
        const cached = await edgeCache.match(request.url);
        if (cached) {
          const hit = new Response(cached.body, cached);
          hit.headers.set('Access-Control-Allow-Origin', '*');
          return hit;
        }
      } catch (cacheError) { /* 缓存不可用时走正常回源 */ }
    }

    let response = await fetchWithRetry(targetUrl, {
      method: request.method,
      headers: newRequestHeaders,
      body: request.body,
      redirect: redirectMode
    }, 3);

    // 回写边缘缓存：仅缓存 200 的 GET 响应，TTL 跟随上游 Cache-Control（GitHub raw 为 5 分钟）
    if (edgeCache && request.method === 'GET' && response.status === 200) {
      try { await edgeCache.put(request.url, response.clone()); } catch (cacheError) { /* 写缓存失败不影响响应 */ }
    }

    // 处理 Docker 认证挑战（401 时自动获取匿名 token 重试）
    if (isDockerRequest && response.status === 401) {
      const wwwAuth = response.headers.get('WWW-Authenticate');
      const authMatch = wwwAuth && wwwAuth.match(/Bearer realm="([^"]+)",service="([^"]*)",scope="([^"]*)"/);
      if (authMatch) {
        const [, realm, service, scope] = authMatch;
        const token = await handleToken(realm, service || targetDomain, scope);
        const authHeaders = new Headers(newRequestHeaders);
        if (token) {
          authHeaders.set('Authorization', 'Bearer ' + token);
        } else {
          authHeaders.delete('Authorization');
        }
        response = await fetch(targetUrl, {
          method: request.method,
          headers: authHeaders,
          body: request.body,
          redirect: 'manual'
        });
      }
    }

    // 处理 Docker 重定向（镜像层可能多级 CDN 跳转，循环由 Worker 继续反代）
    let redirects = 0;
    while (isDockerRequest && (response.status === 302 || response.status === 307)) {
      const redirectUrl = response.headers.get('Location');
      if (!redirectUrl || redirects >= MAX_REDIRECTS) {
        break;
      }
      redirects++;
      const redirectHeaders = new Headers(newRequestHeaders);
      redirectHeaders.set('Host', new URL(redirectUrl).hostname);

      // 对于 S3 重定向，添加必要的 AWS 头
      if (isAmazonS3(redirectUrl)) {
        redirectHeaders.set('x-amz-content-sha256', getEmptyBodySHA256());
        redirectHeaders.set('x-amz-date', getAmzDate());
      }

      response = await fetch(redirectUrl, {
        method: request.method,
        headers: redirectHeaders,
        body: request.body,
        redirect: 'manual'
      });
    }

    // 复制响应并添加 CORS 头
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');

    if (isDockerRequest) {
      newResponse.headers.set('Docker-Distribution-API-Version', 'registry/2.0');
      // 删除可能存在的重定向头，确保所有请求都通过 Worker 处理
      newResponse.headers.delete('Location');
    }

    return newResponse;
  } catch (error) {
    // 回源超时（AbortError）报 504 与边缘函数被平台掐断的现象区分开，其余错误报 500
    const isTimeout = error && error.name === 'AbortError';
    return new Response('Error fetching from ' + targetDomain + ': ' + error.message + '\n', { status: isTimeout ? 504 : 500 });
  }
}

// EdgeOne Pages 部署入口：仓库根的 _worker.js 供 Cloudflare 兼容场景使用，
// 本文件由 _worker.js 生成（仅替换导出段），修改逻辑后需同步重新生成
export async function onRequest(context) {
  return handleRequest(context.request);
}
