import Foundation
import CoreGraphics

func sendClick(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)
    guard let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        return
    }
    mouseDown.post(tap: CGEventTapLocation.cghidEventTap)
    usleep(50000)
    mouseUp.post(tap: CGEventTapLocation.cghidEventTap)
    usleep(100000)
}

func sendDrag(fromX: Double, fromY: Double, toX: Double, toY: Double, steps: Int = 30, durationMs: Int = 400) {
    let start = CGPoint(x: fromX, y: fromY)
    guard let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left) else { return }
    mouseDown.post(tap: CGEventTapLocation.cghidEventTap)
    usleep(60000)

    let stepDelay = useconds_t((durationMs * 1000) / steps)
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let curX = fromX + (toX - fromX) * t
        let curY = fromY + (toY - fromY) * t
        let curPoint = CGPoint(x: curX, y: curY)
        if let drag = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: curPoint, mouseButton: .left) {
            drag.post(tap: CGEventTapLocation.cghidEventTap)
        }
        usleep(stepDelay)
    }

    let end = CGPoint(x: toX, y: toY)
    guard let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left) else { return }
    mouseUp.post(tap: CGEventTapLocation.cghidEventTap)
    usleep(100000)
}

let args = CommandLine.arguments
if args.count >= 4 && args[1] == "click" {
    let x = Double(args[2])!
    let y = Double(args[3])!
    sendClick(x: x, y: y)
} else if args.count >= 6 && args[1] == "drag" {
    let fromX = Double(args[2])!
    let fromY = Double(args[3])!
    let toX = Double(args[4])!
    let toY = Double(args[5])!
    sendDrag(fromX: fromX, fromY: fromY, toX: toX, toY: toY)
} else {
    print("Usage: sim_touch click <x> <y> | sim_touch drag <fromX> <fromY> <toX> <toY>")
}
