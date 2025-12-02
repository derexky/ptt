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
| `args.board` | string | ✓ | 目標看板名稱 |
| `args.subject` | string | △ | 新文章的標題 |
| `args.draft` | string | - | 新文章的內容草稿 (與 `args.subject` 並用) |
| `args.reply` | string | △ | 要回覆的文章編號 (當 `args.subject: undefined` 時必填) |
| `args.target` | string | - | 回覆目標 (與 `args.reply` 並用) |
| `args.stance` | string | - | AI 生成內容的立場 |
| `isSendByWord` | boolean | - | 是否以單詞方式發送 (預設為 `false`) |

## 5. 範例請求 (Example Requests)

### 發布新文章

```json
{
  "id": "user123",
  "password": "securepassword",
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
  "args": {
    "board": "TestBoard",
    "reply": "12345",
    "target": "針對的目標(人事物...)",
    "stance": "AI生成內容的立場"
  },
}
```

## 6. 命令列工具 (CLI Tool)

### 使用方式

```bash
node runPost.js [options]
```

### 環境變數設定

在 `.env` 檔案中設定：

```env
PTT_ID=your_ptt_id
PTT_PASSWORD=your_ptt_password
GEMINI_API_KEY=your_api_key
```

### 命令列參數

| 短參數 | 長參數 | 必填 | 描述 |
|-------|--------|------|------|
| `-b` | `--board` | ✓ | 目標看板名稱 |
| `-s` | `--subject` | △ | 新文章標題 (發新文時必填) |
| `-r` | `--reply` | △ | 回覆的文章編號 (回文時必填) |
| `-p` | `--path` | - | 文章內容檔案路徑 |
| `-t` | `--target` | - | 回覆目標 |
| `-k` | `--kind` | - | 文章類型(目前沒用到) |
| | `--stance` | - | AI 生成內容的立場 |

### 使用範例

#### 發布新文章

```bash
npm run test -- -b Gossiping -s "測試標題" -p ./content.txt

# 使用內容檔案
node runPost.js --board Gossiping --subject "測試標題" --path ./content.txt

# 使用短參數
node runPost.js -b Gossiping -s "測試標題" -p ./content.txt
```

#### 回覆文章

```bash
npm run test -- -b Gossiping -r 123456 -t "某人事物"

# 回覆指定文章
node runPost.js --board Gossiping --reply 123456 --target "某人事物"

# 使用短參數
node runPost.js -b Gossiping -r 123456 -t "某人事物"
