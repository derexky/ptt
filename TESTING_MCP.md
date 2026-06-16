# MCP 接口測試指南

本文件說明如何測試 `ptt-tools` 的 MCP 伺服器功能。

## 方法一：使用測試腳本 (推薦快速檢查)

我已為您建立了 `test-mcp.js`，這是一個自動化測試腳本，用來檢查伺服器是否能正常啟動並列出工具。

### 執行方式
在終端機輸入：
```bash
node test-mcp.js
```

### 預期結果
若成功，您會看到如下輸出：
```
Starting MCP Client...
Connected to MCP Server
Listing tools...
- crawl_new_posts: ...
- crawl_all_posts: ...
...
Success! The MCP server is responding correctly.
```

---

## 方法二：使用 MCP Inspector (圖形化介面)

MCP Inspector 是一個官方提供的視覺化調試工具，可以讓您直接在瀏覽器中測試每個工具。

### 執行方式
在終端機輸入：
```bash
npx @modelcontextprotocol/inspector node mcp-server.js
```

### 使用步驟
1. 執行上述指令後，瀏覽器會自動開啟 Inspector 介面。
2. 在介面左側可以看到 **Tools** 列表。
3. 點擊任一工具 (例如 `crawl_new_posts`)。
4. 在右側輸入參數 (例如 `boardName`: "Gossiping")。
5. 點擊 **Run Tool** 按鈕。
6. 下方會顯示執行結果與 JSON 回應。

## 常見問題
- **Port 佔用**：MCP 使用 stdio 通訊，通常不佔用 port，但 Inspector 會在本機啟動網頁伺服器。
- **環境變數**：請確保 `.env` 檔案設定正確，否則 `generate_ai_content` 等依賴 API Key 的工具可能會失敗。
