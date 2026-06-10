export interface CloudBaseCredentialEnv {
  secretId?: string;
  secretKey?: string;
  sessionToken?: string;
}

export function getCloudBaseCredentialEnv(): CloudBaseCredentialEnv {
  return {
    secretId: process.env.TENCENTCLOUD_SECRETID ?? process.env.TENCENT_SECRET_ID,
    secretKey: process.env.TENCENTCLOUD_SECRETKEY ?? process.env.TENCENT_SECRET_KEY,
    sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN ?? process.env.TENCENT_SESSION_TOKEN,
  };
}

export function applyCloudBaseCredentialEnv<T extends CloudBaseCredentialEnv>(target: T): T {
  const { secretId, secretKey, sessionToken } = getCloudBaseCredentialEnv();
  if (secretId && secretKey) {
    target.secretId = secretId;
    target.secretKey = secretKey;
    if (sessionToken) target.sessionToken = sessionToken;
  }
  return target;
}
