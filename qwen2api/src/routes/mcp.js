const express = require('express');
const router = express.Router();
const { apiKeyVerify } = require('../middlewares/authorization');
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('../utils/proxy-helper');
const accountManager = require('../utils/account.js');
const { logger } = require('../utils/logger');
const axios = require('axios');

/**
 * MCP (Model Context Protocol) 路由處理器
 * 處理來自 qwen2api-plugin 的工具調用請求
 */
router.post('/', apiKeyVerify, async (req, res) => {
  try {
    const { jsonrpc, id, method, params } = req.body;
    
    // 驗證必要字段
    if (!jsonrpc || jsonrpc !== "2.0" || !id || !method || !params) {
      return res.status(400).json({
        jsonrpc: "2.0",
        id: id || null,
        error: {
          code: -32600,
          message: "Invalid Request"
        }
      });
    }
    
    // 只處理 tools/call 方法
    if (method !== "tools/call") {
      return res.status(400).json({
        jsonrpc: "2.0",
        id: id,
        error: {
          code: -32601,
          message: "Method not found"
        }
      });
    }
    
    const { name, arguments: args } = params;
    
    // 根據工具名稱分發到相應的處理函數
    let result;
    switch (name) {
      case "read":
        result = await handleRead(args);
        break;
      case "write":
        result = await handleWrite(args);
        break;
      case "edit":
        result = await handleEdit(args);
        break;
      case "glob":
        result = await handleGlob(args);
        break;
      case "grep":
        result = await handleGrep(args);
        break;
      case "bash":
        result = await handleBash(args);
        break;
      default:
        return res.status(400).json({
          jsonrpc: "2.0",
          id: id,
          error: {
            code: -32602,
            message: `Invalid tool: ${name}`
          }
        });
    }
    
    // 返回成功響應
    res.json({
      jsonrpc: "2.0",
      id: id,
      result: {
        content: [
          {
            type: "text",
            text: result
          }
        ]
      }
    });
  } catch (error) {
    logger.error(`MCP 錯誤: ${error.message}`, "MCP", "", error);
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body?.id || null,
      error: {
        code: -32603,
        message: "Internal error",
        data: error.message
      }
    });
  }
});

/**
 * 讀取檔案內容
 */
async function handleRead(args) {
  const { filePath } = args;
  if (!filePath) {
    throw new Error("Missing required argument: filePath");
  }
  
  const fs = require('fs').promises;
  const path = require('path');
  
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (error) {
    throw new Error(`Failed to read file: ${error.message}`);
  }
}

/**
 * 寫入檔案內容
 */
async function handleWrite(args) {
  const { filePath, content } = args;
  if (!filePath) {
    throw new Error("Missing required argument: filePath");
  }
  if (content === undefined) {
    throw new Error("Missing required argument: content");
  }
  
  const fs = require('fs').promises;
  const path = require('path');
  
  try {
    // 確保目錄存在
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    
    // 寫入檔案
    await fs.writeFile(filePath, content, 'utf8');
    return `Successfully wrote to ${filePath}`;
  } catch (error) {
    throw new Error(`Failed to write file: ${error.message}`);
  }
}

/**
 * 編輯檔案內容（尋找並取代文字）
 */
async function handleEdit(args) {
  const { filePath, oldString, newString = "" } = args;
  if (!filePath) {
    throw new Error("Missing required argument: filePath");
  }
  if (oldString === undefined) {
    throw new Error("Missing required argument: oldString");
  }
  
  const fs = require('fs').promises;
  
  try {
    let content = await fs.readFile(filePath, 'utf8');
    const newContent = content.split(oldString).join(newString);
    await fs.writeFile(filePath, newContent, 'utf8');
    return `Successfully edited ${filePath}`;
  } catch (error) {
    throw new Error(`Failed to edit file: ${error.message}`);
  }
}

/**
 * 搜尋檔案（支援 glob 模式）
 */
async function handleGlob(args) {
  const { pattern, path: searchPath = "." } = args;
  if (!pattern) {
    throw new Error("Missing required argument: pattern");
  }
  
  const glob = require("glob");
  const path = require('path');
  
  try {
    // 轉換為絕對路徑
    const absolutePath = path.isAbsolute(searchPath) ? searchPath : path.resolve(process.cwd(), searchPath);
    const files = await new Promise((resolve, reject) => {
      glob(pattern, { cwd: absolutePath, absolute: true }, (err, files) => {
        if (err) reject(err);
        else resolve(files);
      });
    });
    
    return JSON.stringify(files);
  } catch (error) {
    throw new Error(`Failed to glob files: ${error.message}`);
  }
}

/**
 * 在檔案中搜尋文字內容
 */
async function handleGrep(args) {
  const { pattern, path: searchPath = ".", include } = args;
  if (!pattern) {
    throw new Error("Missing required argument: pattern");
  }
  
  const fs = require('fs').promises;
  const path = require('path');
  
  try {
    // 轉換為絕對路徑
    const absolutePath = path.isAbsolute(searchPath) ? searchPath : path.resolve(process.cwd(), searchPath);
    
    // 讀取目錄內容
    const files = await fs.readdir(absolutePath);
    
    // 過濾檔案（如果指定了 include 模式）
    let filteredFiles = files;
    if (include) {
      const minimatch = require("minimatch");
      filteredFiles = files.filter(file => minimatch(file, include));
    }
    
    // 在每個檔案中搜尋
    const results = [];
    for (const file of filteredFiles) {
      const filePath = path.join(absolutePath, file);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        const matches = [];
        
        lines.forEach((line, lineIndex) => {
          if (line.includes(pattern)) {
            matches.push({
              line: lineIndex + 1,
              content: line.trim()
            });
          }
        });
        
        if (matches.length > 0) {
          results.push({
            file: filePath,
            matches: matches
          });
        }
      } catch (error) {
        // 忽略無法讀取的檔案
        logger.warn(`Cannot read file ${filePath}: ${error.message}`, "GREP");
      }
    }
    
    return JSON.stringify(results);
  } catch (error) {
    throw new Error(`Failed to grep files: ${error.message}`);
  }
}

/**
 * 執行 shell 命令
 */
async function handleBash(args) {
  const { command } = args;
  if (!command) {
    throw new Error("Missing required argument: command");
  }
  
  const { exec } = require('child_process');
  
  try {
    return await new Promise((resolve, reject) => {
      exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed with exit code ${error.code}: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  } catch (error) {
    throw new Error(`Failed to execute command: ${error.message}`);
  }
}

module.exports = router;
