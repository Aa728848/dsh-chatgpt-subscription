/**
 * Real GET /status payloads, captured from a running host (11 lines).
 *
 * These are the fixture, not hand-written minimal objects, because the whole
 * point of the normalizers is the mismatch between what the lines actually
 * send: seconds vs milliseconds vs ISO, used percent vs used fraction vs
 * remaining share, per-account readings, and quota: null on a first read.
 * A synthetic object would encode the same assumptions as the mapper and
 * could never fail.
 *
 * Trimmed only by dropping keys no normalizer reads (catalogs, settings
 * documents, proxy diagnostics, legal notices); every value a mapper or a
 * test relies on is exactly what the host sent.
 */
export const LIVE_STATUS_PAYLOADS: Readonly<Record<string, unknown>> = {
  "codex": {
    "ok": true,
    "value": {
      "authenticated": true,
      "account": {
        "email": "c***@gmail.com",
        "planType": "free",
        "accountIdSuffix": "…211f",
        "tokenExpiresAt": 1793149935
      },
      "accounts": [
        {
          "id": "acc_6dfc46661c96",
          "alias": "cchen2422@gmail.com",
          "isPrimary": true,
          "expiresAt": 1793149935038,
          "email": "cchen2422@gmail.com",
          "planLabel": "free",
          "adopted": false,
          "source": "managed",
          "removable": true,
          "quota": {
            "windows": [
              {
                "label": "",
                "usedPercent": 0,
                "windowDurationMins": 43200,
                "resetsAt": 1795250462000
              }
            ],
            "fetchedAt": 1792658463470
          }
        }
      ],
      "activeAccountId": "acc_6dfc46661c96",
      "rotationStrategy": "sequential",
      "storage": {
        "kind": "windows-dpapi",
        "encrypted": true,
        "available": true
      },
      "login": {
        "active": false,
        "loginId": null,
        "expiresAt": null
      },
      "quota": {
        "state": "ready",
        "buckets": [
          {
            "id": "codex",
            "name": "Codex",
            "planType": "free",
            "primary": {
              "usedPercent": 0,
              "windowDurationMins": 43200,
              "resetsAt": 1795250462
            },
            "secondary": null,
            "windows": [
              {
                "usedPercent": 0,
                "windowDurationMins": 43200,
                "resetsAt": 1795250462
              }
            ]
          }
        ],
        "credits": {
          "hasCredits": false,
          "unlimited": false,
          "balance": null
        },
        "individualLimit": null,
        "spendControlReached": false,
        "resetCredits": {
          "availableCount": 1,
          "expiresAt": 1792701235
        },
        "fetchedAt": 1792658463,
        "stale": true
      },
      "quotaRefreshing": true,
      "codexCliSignInPath": "C:\\Users\\A\\.codex\\auth.json"
    }
  },
  "claude": {
    "ok": true,
    "value": {
      "enabled": false,
      "authenticated": false,
      "hasCredentials": false,
      "storagePath": "C:\\Users\\A\\.dsh\\storages\\claude-pool.json.dpapi",
      "serving": true,
      "conflict": null,
      "claudeCodeSignInAvailable": false,
      "claudeCodePaths": [
        "C:\\Users\\A\\.claude\\.credentials.json"
      ],
      "account": null,
      "quota": null,
      "lastFetchedAt": null,
      "quotaError": null,
      "cacheTtl": null,
      "selectedAccountId": null,
      "accounts": [],
      "rotationStrategy": "sequential",
      "quotaRefreshing": false
    }
  },
  "glm-coding-plan": {
    "ok": true,
    "value": {
      "accounts": [
        {
          "id": "acc_12045e879ccc",
          "alias": "默认机构(101033) · 账号 1",
          "isPrimary": true,
          "lastUsedAt": 1792592328609,
          "region": "cn",
          "organizationId": "org-72CE9143B1D64E8FB2266E2e92E4b301",
          "accountName": "默认机构(101033)",
          "removable": true
        }
      ],
      "activeAccountId": "acc_12045e879ccc",
      "rotationStrategy": "sequential",
      "poolInstalled": true,
      "enabled": false,
      "authenticated": true,
      "hasCredentials": true,
      "providerId": "glm-coding-plan",
      "storagePath": "C:\\Users\\A\\.dsh\\storages\\glm-coding-plan-pool.json.dpapi",
      "region": "cn",
      "account": {
        "id": "org-72CE9143B1D64E8FB2266E2e92E4b301:67481775105101033",
        "userId": "67481775105101033",
        "email": null,
        "displayName": "dytlrnx8",
        "region": "cn",
        "authenticatedAt": 1791767085336
      },
      "quota": null,
      "allowance": "unknown",
      "lastFetchedAt": null,
      "quotaRefreshing": false,
      "quotaError": "GLM（ZCode 账号） 上游没有返回可显示的额度窗口。",
      "login": {
        "status": "idle"
      },
      "serving": true,
      "conflict": null
    }
  },
  "step-code": {
    "ok": true,
    "value": {
      "accounts": [
        {
          "id": "acc_ae306a4b1885",
          "alias": "412810294173683712 · 账号 1",
          "isPrimary": true,
          "lastUsedAt": 1792657983481,
          "profile": "step_plan",
          "region": "cn",
          "accountName": "412810294173683712"
        }
      ],
      "rotationStrategy": "sequential",
      "activeAccountId": "acc_ae306a4b1885",
      "enabled": true,
      "authenticated": true,
      "hasCredentials": true,
      "providerId": "step-code",
      "storagePath": "C:\\Users\\A\\.dsh\\storages\\step-code-pool.json.dpapi",
      "profile": "step_plan",
      "account": {
        "id": "acc_ae306a4b1885",
        "alias": "412810294173683712 · 账号 1",
        "isPrimary": true,
        "lastUsedAt": 1792657983481,
        "profile": "step_plan",
        "region": "cn",
        "accountName": "412810294173683712"
      },
      "quota": null,
      "lastFetchedAt": null,
      "quotaRefreshing": false,
      "quotaError": "Step Code（Step Plan 订阅） 额度读取失败：/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus 返回 HTTP 401（{\"code\":\"unauthenticated\",\"message\":\"auth failed: token is expired\",\"details\":[{\"type\":\"step.openapi.devcenter.Error\",\"value\":\"CMCpBw\",\"debug\":{\"@type\":\"type.go）",
      "login": {
        "status": "idle"
      },
      "quotaCredential": {
        "hasCredential": true,
        "source": "auto",
        "account": "1729375685@qq.com",
        "expiresAt": null,
        "error": "Step Code（Step Plan 订阅） 额度读取失败：/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus 返回 HTTP 401（{\"code\":\"unauthenticated\",\"message\":\"auth failed: token is expired\",\"details\":[{\"type\":\"step.openapi.devcenter.Error\",\"value\":\"CMCpBw\",\"debug\":{\"@type\":\"type.go）"
      },
      "cacheRequestParams": false,
      "serving": true,
      "conflict": null
    }
  },
  "qoder": {
    "ok": true,
    "value": {
      "accounts": [
        {
          "id": "acc_11ec513a5182",
          "alias": "For SK · 账号 1",
          "isPrimary": true,
          "lastUsedAt": 1792592328619,
          "expiresAt": 1795104477000,
          "region": "global",
          "origin": "device",
          "email": "cchen2422@gmail.com",
          "accountName": "For SK"
        },
        {
          "id": "acc_ce94f85990a7",
          "alias": "SK · 账号 2",
          "isPrimary": false,
          "expiresAt": 1795104506000,
          "region": "global",
          "origin": "device",
          "email": "1729375685@qq.com",
          "accountName": "SK"
        }
      ],
      "rotationStrategy": "sequential",
      "activeAccountId": "acc_11ec513a5182",
      "enabled": false,
      "authenticated": true,
      "hasCredentials": true,
      "providerId": "qoder",
      "storagePath": "C:\\Users\\A\\.dsh\\storages\\qoder-pool.json.dpapi",
      "region": "global",
      "account": {
        "id": "acc_11ec513a5182",
        "alias": "For SK · 账号 1",
        "isPrimary": true,
        "lastUsedAt": 1792592328619,
        "expiresAt": 1795104477000,
        "region": "global",
        "origin": "device",
        "email": "cchen2422@gmail.com",
        "accountName": "For SK"
      },
      "quota": {
        "buckets": [
          {
            "kind": "personal",
            "total": 0,
            "used": 0,
            "remaining": 0,
            "unit": "credits"
          }
        ],
        "expiresAt": 253402214400000,
        "fetchedAt": 1792658467268,
        "region": "global"
      },
      "lastFetchedAt": 1792658467268,
      "quotaRefreshing": true,
      "catalogRefreshing": false,
      "quotaError": null,
      "login": {
        "status": "idle"
      },
      "serving": true,
      "conflict": null
    }
  },
  "cline-pass": {
    "ok": true,
    "value": {
      "enabled": false,
      "providerId": "cline-pass",
      "baseURL": "https://api.cline.bot/api/v1",
      "serving": true,
      "conflict": null,
      "exposeTools": false,
      "usable": false,
      "authenticated": false,
      "pool": {
        "accounts": [],
        "rotationStrategy": "sequential"
      },
      "usage": null,
      "quotaRefreshing": false,
      "login": null
    }
  },
  "opendesign": {
    "ok": true,
    "value": {
      "enabled": true,
      "providerId": "opendesign",
      "baseURL": "https://amr-link.open-design.ai/v1",
      "serving": true,
      "conflict": null,
      "usable": true,
      "authenticated": true,
      "pool": {
        "accounts": [
          {
            "id": "acc_b62e6bcbfd44",
            "alias": "For SK",
            "isPrimary": true,
            "lastUsedAt": 1792658929538,
            "authKind": "oauth",
            "email": "cchen2422@gmail.com",
            "plan": "free",
            "planLabel": "deepseek-v4.1-flash"
          }
        ],
        "rotationStrategy": "sequential",
        "activeAccountId": "acc_b62e6bcbfd44"
      },
      "usage": null,
      "login": null
    }
  },
  "kimi-code": {
    "ok": true,
    "value": {
      "enabled": true,
      "authenticated": true,
      "hasCredentials": true,
      "storagePath": "C:\\Users\\A\\.dsh\\storages\\kimi-code-credentials.json.dpapi",
      "region": "mainland-cn",
      "oauthHost": "https://auth.kimi.com",
      "codingBaseUrl": "https://api.kimi.com/coding",
      "accounts": [
        {
          "id": "acc_primary",
          "alias": "账号 2",
          "isPrimary": true,
          "lastUsedAt": 1792559783295,
          "expiresAt": 1792659361360,
          "region": "mainland-cn",
          "userId": "ctba96rf4kmlkas2tnag",
          "quota": {
            "windows": [
              {
                "label": "5-hour",
                "usedPercent": 0,
                "windowDurationMins": 300,
                "resetsAt": 1792672850000
              },
              {
                "label": "Weekly (7-day)",
                "usedPercent": 0,
                "windowDurationMins": 10080,
                "resetsAt": 1793198450000
              }
            ],
            "fetchedAt": 1792658462522
          }
        }
      ],
      "activeAccountId": "acc_primary",
      "rotationStrategy": "sequential",
      "account": {
        "userId": "ctba96rf4kmlkas2tnag",
        "nickname": "快跑",
        "email": null,
        "planName": "Allegro",
        "planLevel": "27",
        "region": "mainland-cn",
        "authenticatedAt": 1792406442558
      },
      "quota": {
        "account": {
          "userId": "ctba96rf4kmlkas2tnag",
          "nickname": "快跑",
          "email": null,
          "planName": "Allegro",
          "planLevel": "27",
          "region": "mainland-cn",
          "authenticatedAt": 1792406442558
        },
        "planName": "Allegro",
        "windows": [
          {
            "id": "limit_5h",
            "label": "5-hour",
            "usedFraction": 0,
            "usedPercent": 0,
            "windowDurationMins": 300,
            "resetsAt": 1792672850000,
            "limit": null,
            "used": null,
            "remaining": null
          },
          {
            "id": "limit_7d",
            "label": "Weekly (7-day)",
            "usedFraction": 0,
            "usedPercent": 0,
            "windowDurationMins": 10080,
            "resetsAt": 1793198450000,
            "limit": null,
            "used": null,
            "remaining": null
          }
        ],
        "extraUsage": {
          "balanceCents": 7500,
          "totalCents": 7500,
          "monthlyChargeLimitEnabled": false,
          "monthlyChargeLimitCents": 10000,
          "monthlyUsedCents": 0,
          "currency": "CNY"
        },
        "fetchedAt": 1792658462522,
        "sources": [
          "https://api.kimi.com/coding/v1/usages"
        ]
      },
      "lastFetchedAt": 1792658462522,
      "credentialsRejected": false,
      "preserveThinking": true,
      "cacheTtl": "1h",
      "loginRegion": "mainland-cn",
      "serving": true,
      "conflict": null,
      "quotaError": null,
      "quotaRefreshing": true
    }
  },
  "minimax-code": {
    "ok": true,
    "value": {
      "accounts": [
        {
          "id": "acc_85680bed1458",
          "alias": "MiniMax Code · cn · 账号 2",
          "isPrimary": true,
          "lastUsedAt": 1792558701335,
          "expiresAt": 1792661826780,
          "region": "cn",
          "source": "file",
          "generation": 152,
          "removable": true,
          "quota": {
            "windows": [
              {
                "label": "",
                "usedPercent": 14,
                "windowDurationMins": 300,
                "resetsAt": 1792669916718
              },
              {
                "label": "",
                "usedPercent": 54,
                "windowDurationMins": 10080,
                "resetsAt": 1793011729936
              }
            ],
            "fetchedAt": 1792658462726
          }
        },
        {
          "id": "acc_94575600a31f",
          "alias": "MiniMax Code · cn · 账号 2",
          "isPrimary": false,
          "lastUsedAt": 1792036927096,
          "expiresAt": 1792516025756,
          "region": "cn",
          "source": "file",
          "generation": 131,
          "removable": true
        }
      ],
      "activeAccountId": "acc_85680bed1458",
      "rotationStrategy": "sequential",
      "poolInstalled": true,
      "serving": true,
      "conflict": null,
      "enabled": true,
      "authenticated": true,
      "providerId": "minimax-code",
      "region": "cn",
      "storage": {
        "kind": "file",
        "path": "C:\\Users\\A\\.dsh\\storages\\minimax-code-credentials.json"
      },
      "account": {
        "id": "mcode-public/cn/597eef3e-b235-43ec-801c-388b36d22b09",
        "label": "MiniMax Code · cn",
        "generation": 152,
        "expiresAtMs": 1792661826780
      },
      "ownedByPlugin": true,
      "quota": {
        "label": "Token Plan",
        "usedPercent": 14,
        "resetsAtMs": 1792669916718,
        "windows": [
          {
            "key": "interval",
            "remainingPercent": 86,
            "usedPercent": 14,
            "resetsAtMs": 1792669916718
          },
          {
            "key": "weekly",
            "remainingPercent": 46,
            "usedPercent": 54,
            "resetsAtMs": 1793011729936
          }
        ],
        "fetchedAtMs": 1792658462726
      },
      "checkin": {
        "enabled": true,
        "totalAccounts": 2,
        "doneToday": 0,
        "skippedToday": 0,
        "failedToday": 2,
        "lastRunAt": 1792658551100
      },
      "quotaRefreshing": true
    }
  },
  "antigravity": {
    "ok": true,
    "value": {
      "enabled": true,
      "authenticated": true,
      "email": "cchen2422@gmail.com",
      "projectId": "aicode-consumers",
      "hasCredentials": true,
      "storagePath": "C:\\Users\\A\\.dsh\\storages\\antigravity-oauth.json.dpapi",
      "lastFetchedAt": 1792658467464,
      "quota": {
        "projectId": "aicode-consumers",
        "endpoint": "https://daily-cloudcode-pa.googleapis.com",
        "planLabel": "Google AI Ultra",
        "productTier": {
          "id": "free-tier",
          "name": "Antigravity",
          "description": "Gemini-powered code suggestions and chat in multiple IDEs",
          "upgradeSubscriptionType": "GOOGLE_ONE_HELIUM"
        },
        "paidTier": {
          "id": "g1-ultra-tier",
          "name": "Google AI Ultra",
          "description": "Google AI Ultra",
          "availableCredits": [
            {
              "creditType": "GOOGLE_ONE_AI",
              "minimumCreditAmountForUsage": "50"
            }
          ]
        },
        "groups": [
          {
            "displayName": "Gemini Models",
            "description": "Models within this group: Gemini Flash, Gemini Pro",
            "buckets": [
              {
                "bucketId": "gemini-weekly",
                "displayName": "Weekly Limit Remaining",
                "window": "weekly",
                "resetTime": "2026-10-24T06:23:12Z",
                "description": "You have used some of your weekly limit, it will fully refresh in 1 day, 21 hours.",
                "remainingFraction": 0.7558998
              },
              {
                "bucketId": "gemini-5h",
                "displayName": "Five Hour Limit Remaining",
                "window": "5h",
                "resetTime": "2026-10-22T12:25:00Z",
                "description": "You have used some of your 5-hour limit, it will fully refresh in 3 hours, 43 minutes.",
                "remainingFraction": 0.9784805
              }
            ]
          },
          {
            "displayName": "Claude and GPT models",
            "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
            "buckets": [
              {
                "bucketId": "3p-weekly",
                "displayName": "Weekly Limit Remaining",
                "window": "weekly",
                "resetTime": "2026-10-26T17:13:29Z",
                "description": "You have used some of your weekly limit, it will fully refresh in 4 days, 8 hours.",
                "remainingFraction": 0.75744927
              },
              {
                "bucketId": "3p-5h",
                "displayName": "Five Hour Limit Remaining",
                "window": "5h",
                "resetTime": "2026-10-22T13:41:05Z",
                "remainingFraction": 1
              }
            ]
          }
        ],
        "fetchedAt": 1792658467464
      },
      "accounts": [
        {
          "id": "acc_primary",
          "alias": "cchen2422@gmail.com",
          "isPrimary": true,
          "lastUsedAt": 1792512604602,
          "expiresAt": 1792513751555,
          "projectId": "aicode-consumers",
          "email": "cchen2422@gmail.com",
          "quota": {
            "windows": [
              {
                "label": "Gemini Models · Weekly Limit Remaining",
                "usedPercent": 24.41002,
                "windowDurationMins": null,
                "resetsAt": 1792822992000
              },
              {
                "label": "Gemini Models · Five Hour Limit Remaining",
                "usedPercent": 2.1519500000000025,
                "windowDurationMins": null,
                "resetsAt": 1792671900000
              },
              {
                "label": "Claude and GPT models · Weekly Limit Remaining",
                "usedPercent": 24.255073000000003,
                "windowDurationMins": null,
                "resetsAt": 1793034809000
              },
              {
                "label": "Claude and GPT models · Five Hour Limit Remaining",
                "usedPercent": 0,
                "windowDurationMins": null,
                "resetsAt": 1792676465000
              }
            ],
            "fetchedAt": 1792658467464
          }
        }
      ],
      "activeAccountId": "acc_primary",
      "rotationStrategy": "sequential",
      "quotaRefreshing": true
    }
  },
  "command-code": {
    "ok": true,
    "value": {
      "enabled": false,
      "authenticated": true,
      "hasCredentials": true,
      "storagePath": "C:\\Users\\A\\.dsh\\storages\\command-code-credentials.json.dpapi",
      "apiEnv": "prod",
      "accounts": [
        {
          "id": "acc_primary",
          "alias": "1729375685@qq.com",
          "isPrimary": true,
          "lastUsedAt": 1790587334218,
          "email": "1729375685@qq.com",
          "keyName": "cli-2026-09-15T09-29-56",
          "userName": "Aa728848",
          "userId": "bbba4ac7-cdce-41b7-bcf3-bbae0603cd1f",
          "quota": {
            "windows": [],
            "fetchedAt": 1792658466348
          }
        }
      ],
      "activeAccountId": "acc_primary",
      "rotationStrategy": "sequential",
      "account": {
        "userId": "bbba4ac7-cdce-41b7-bcf3-bbae0603cd1f",
        "userName": "Aa728848",
        "email": "1729375685@qq.com",
        "organizationName": null,
        "keyName": "cli-2026-09-15T09-29-56",
        "planLabel": null,
        "planId": null,
        "authenticatedAt": 1789464599838
      },
      "quota": {
        "account": {
          "userId": "bbba4ac7-cdce-41b7-bcf3-bbae0603cd1f",
          "userName": "Aa728848",
          "email": "1729375685@qq.com",
          "organizationName": null,
          "keyName": "cli-2026-09-15T09-29-56",
          "planLabel": null,
          "planId": null,
          "authenticatedAt": 1789464599838
        },
        "creditBalance": "0",
        "unlimited": false,
        "planId": null,
        "planName": null,
        "planMonthlyCredits": null,
        "subscriptionStatus": null,
        "periodEndsAt": null,
        "meters": [
          {
            "id": "monthly-credits",
            "label": "Monthly credits",
            "usedFraction": null,
            "remainingFraction": null,
            "used": null,
            "limit": "0",
            "resetsAt": null,
            "description": "Remaining credits from the plan allowance"
          },
          {
            "id": "purchased-credits",
            "label": "Purchased credits",
            "usedFraction": null,
            "remainingFraction": null,
            "used": null,
            "limit": "0",
            "resetsAt": null,
            "description": "Remaining pay-as-you-go credits"
          },
          {
            "id": "free-credits",
            "label": "Free credits",
            "usedFraction": null,
            "remainingFraction": null,
            "used": null,
            "limit": "0",
            "resetsAt": null,
            "description": "Remaining promotional credits"
          }
        ],
        "windows": [],
        "fetchedAt": 1792658466348,
        "sources": [
          "whoami",
          "billing/credits",
          "billing/subscriptions",
          "usage/summary"
        ]
      },
      "lastFetchedAt": 1792658466348,
      "serving": true,
      "conflict": null,
      "quotaRefreshing": true
    }
  }
}
