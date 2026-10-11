/// <reference types="vite/client" />
declare module "*.toml?raw" {
  const content: string;
  export default content;
}
declare module "sql.js/dist/sql-asm-memory-growth.js" {
  import initSqlJs from "sql.js";
  export default initSqlJs;
}
