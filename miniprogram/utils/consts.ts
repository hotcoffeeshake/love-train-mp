// 云托管服务名（和云托管控制台创建的服务名一致）
export const CLOUD_CONTAINER_SERVICE = 'love-train-mp';

// 云开发环境 ID：部署前替换为真实值，或走 wx.cloud.init({ env: ... }) 读取
// 开发期允许留空，由开发者工具的"云开发环境"下拉选择兜底
export const CLOUDBASE_ENV_ID = 'cool123-d0gec5og96116475f';

// 默认日均配额（前端仅作为后端 /auth/me 未返回时的兜底）
export const DEFAULT_DAILY_QUOTA = 10;

// 本地历史最大条数
export const MAX_LOCAL_HISTORY = 50;
