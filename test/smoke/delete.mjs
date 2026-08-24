
import Database from 'better-sqlite3';
const db = new Database('/home/ubuntu/MCP/mcp-sqlserv/test/smoke/data/projects/30d8e1e4-e3e4-410b-8c44-6b59cce296a3/app.db');
db.prepare("DELETE FROM custom_tools WHERE id='smk1'").run();
db.close();