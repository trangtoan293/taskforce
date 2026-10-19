// "What do I do now?": one next step for the person, derived from the board. Pure.
import type { AgentRec, Board } from '../types'

export type Guide = {
  step: 1 | 2 | 3 | 4
  title: string
  doThis: string
  command?: string
  tone: 'action' | 'wait' | 'warn' | 'done'
}

export const STEP_NAMES = ['Cài đặt', 'Lên kế hoạch', 'Chạy', 'Duyệt kết quả'] as const

export function nextStep(board: Board, agents: AgentRec[]): Guide {
  if (!board.hasConfig)
    return {
      step: 1, tone: 'action', title: 'Repo này chưa được cài taskforce',
      doThis: 'Claude sẽ xem repo, đề xuất lệnh kiểm tra (build/test) và hỏi anh duyệt trước khi lưu.',
      command: '/taskforce:setup',
    }
  const tasks = board.tasks
  const count = (s: string) => tasks.filter(t => t.status === s).length
  if (board.paused)
    return {
      step: 3, tone: 'warn', title: 'Đang TẠM DỪNG: mọi agent bị chặn',
      doThis: 'Bấm C để tiếp tục, hoặc gõ lệnh dưới đây.', command: '/tf resume',
    }
  if (!tasks.length)
    return {
      step: 2, tone: 'action', title: 'Chưa có việc nào',
      doThis: 'Mô tả việc cần làm bằng lời thường. Claude chia thành task nhỏ và hỏi anh duyệt.',
      command: '/taskforce:plan <mô tả việc cần làm>',
    }
  const running = count('building') > 0 || agents.some(a => a.status === 'running' && a.id !== 'main')
  if (running)
    return {
      step: 3, tone: 'wait', title: `Đang chạy: ${count('building')} task đang làm, ${count('merged')}/${tasks.length} đã xong`,
      doThis: 'Không cần làm gì. Xem tiến độ ở tab Task. Muốn dừng gấp: bấm X.',
    }
  if (count('pending') || count('ready'))
    return {
      step: 3, tone: 'action', title: `${count('pending') + count('ready')} task đang chờ chạy`,
      doThis: 'Claude sẽ tự làm từng task, kiểm tra, rồi gộp vào nhánh tích hợp. Anh có thể đóng máy sau khi bắt đầu, lần sau chạy lại lệnh này để làm tiếp.',
      command: '/taskforce:run',
    }
  const blocked = count('blocked')
  if (blocked)
    return {
      step: 4, tone: 'warn', title: `${blocked} task cần anh quyết định`,
      doThis: 'Xem lý do ở tab Task. Sửa được thì bấm T để chạy lại task blocked; không thì để đó hoặc mô tả lại bằng /taskforce:plan.',
      command: '/tf retry <id>',
    }
  return {
    step: 4, tone: 'done', title: `Xong cả ${tasks.length} task`,
    doThis: 'Mọi thứ đã nằm trên nhánh tích hợp. Anh xem lại rồi tự merge lên nhánh chính khi hài lòng. Có việc mới thì lên kế hoạch tiếp.',
    command: '/taskforce:plan <việc tiếp theo>',
  }
}
