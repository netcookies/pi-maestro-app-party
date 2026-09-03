/**
 * Maestro Mobile — Host 入口
 *
 * 启动流程：
 * 1. 解析命令行参数
 * 2. 创建 HostController（管理 Pi SDK AgentSession）
 * 3. 创建 MaestroStateReader（读取 flow-schedule 状态）
 * 4. 启动 WebSocket Server（HTTP + WS 统一端口）
 * 5. 注册信号处理和优雅关闭
 */