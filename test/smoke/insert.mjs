
import Database from 'better-sqlite3';
const db = new Database('/home/ubuntu/MCP/mcp-sqlserv/test/smoke/data/projects/21007317-b125-4683-b344-862dabf0aefd/app.db');
db.prepare("INSERT INTO custom_tools (id,name,title,description,mode,definition,enabled,created_at,updated_at) VALUES ('smk1','smoke_tool','Smoke Tool','tool uji','builder',?,1,datetime('now'),datetime('now'))").run("{\"mode\":\"builder\",\"builder\":{\"baseTable\":\"MstUserLog\",\"joins\":[],\"where\":[],\"orderBy\":[],\"limit\":100},\"params\":[]}");
db.close();