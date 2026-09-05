
import Database from 'better-sqlite3';
const db = new Database('/home/ubuntu/MCP/mcp-sqlserv/test/smoke/data/projects/21007317-b125-4683-b344-862dabf0aefd/app.db');
db.prepare("DELETE FROM custom_tools WHERE id='smk1'").run();
db.close();