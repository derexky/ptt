# Firebase Cloud Functions API 文件

## 1. 檔案結構 (File Structure)

```
your-project-root
├── index.js          # 您的 Cloud Function 程式碼
├── package.json
└── external/
    └── poster.js     # 處理發文邏輯的 Poster 類別
```

## 2. Firebase 部署 (Firebase Deployment)

```bash
# 登入 Firebase
firebase login

# 選擇專案
firebase use <your-project-id>

# 部署 functions
firebase deploy --only functions
```

## 3. API 端點 (API Endpoints)

| 函式名稱 | 區域 (Region) | HTTP Method |
|---------|--------------|-------------|
| `postUs` | `us-central1` (default) | POST |
| `post` | `asia-east1` | POST |
| `postEu` | `europe-west1` | POST |

## 4. 請求格式 (Request Body Format)

| 欄位 | 類型 | 必填 | 描述 |
|-----|------|------|------|
| `id` | string | ✓ | 用於登入發文的使用者 ID |
| `password` | string | ✓ | 用於登入發文的密碼 |
| `isNewPost` | boolean | ✓ | 判斷是發新文章 (`true`) 還是回覆文章 (`false`) |
| `args.board` | string | ✓ | 目標看板名稱 |
| `args.subject` | string | △ | 新文章的標題 (當 `isNewPost: true` 時必填) |
| `args.reply` | string | △ | 要回覆的文章編號 (當 `isNewPost: false` 時必填) |
| `args.draft` | string | - | 新文章的內容草稿 (當 `isNewPost: true` 時使用) |
| `args.stance` | string | - | AI 生成內容的立場 |
| `args.target` | string | - | 回覆目標 (當 `isNewPost: false` 時使用) |
| `isSendByWord` | boolean | - | 是否以單詞方式發送 (預設為 `false`) |

## 5. 範例請求 (Example Requests)

### 發布新文章

```json
{
  "id": "user123",
  "password": "securepassword",
  "isNewPost": true,
  "args": {
    "board": "TestBoard",
    "subject": "這是一篇新的測試文章標題",
    "draft": "文章內容草稿。",
    "stance": "AI生成內容的立場"
  }
}
```

### 回覆文章

```json
{
  "id": "user123",
  "password": "securepassword",
  "isNewPost": false,
  "args": {
    "board": "TestBoard",
    "reply": "12345",
    "target": "針對的目標(人事物...)",
    "stance": "AI生成內容的立場"
  },
}
```
