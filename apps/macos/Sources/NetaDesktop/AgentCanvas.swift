import SwiftUI

struct AgentCanvas: View {
	let project: NetaProject
	let selectedAgentID: String?
	let interactionInsets: EdgeInsets
	let onSelectAgent: (String) -> Void

	@State private var committedPan = CGSize.zero
	@GestureState private var activePan = CGSize.zero
	@State private var zoom: CGFloat = 1
	@GestureState private var activeMagnification: CGFloat = 1

	var body: some View {
		GeometryReader { geometry in
			let effectiveZoom = clampedZoom(zoom * activeMagnification)
			let effectivePan = CGSize(
				width: committedPan.width + activePan.width,
				height: committedPan.height + activePan.height
			)

			ZStack {
				DotGrid(spacing: 28 * effectiveZoom, offset: effectivePan)
				ConnectionLayer(
					agents: project.agents,
					size: geometry.size,
					pan: effectivePan,
					zoom: effectiveZoom
				)
				ForEach(project.agents) { agent in
					AgentNode(agent: agent, isSelected: agent.id == selectedAgentID) {
						onSelectAgent(agent.id)
					}
					.position(point(for: agent.position, size: geometry.size, pan: effectivePan, zoom: effectiveZoom))
				}
			}
			.contentShape(Rectangle())
			.gesture(panGesture)
			.simultaneousGesture(magnificationGesture)
			.overlay {
				TrackpadPanCapture { delta in
					committedPan.width += delta.width
					committedPan.height += delta.height
				}
				.padding(interactionInsets)
				.allowsHitTesting(false)
			}
			.overlay(alignment: .top) {
				CanvasToolbar(
					projectName: project.name,
					zoom: effectiveZoom,
					onZoomOut: { zoom = clampedZoom(zoom - 0.1) },
					onReset: {
						zoom = 1
						committedPan = .zero
					},
					onZoomIn: { zoom = clampedZoom(zoom + 0.1) }
				)
				.padding(.top, 24)
			}
		}
	}

	private var panGesture: some Gesture {
		DragGesture(minimumDistance: 2)
			.updating($activePan) { value, state, _ in
				state = value.translation
			}
			.onEnded { value in
				committedPan.width += value.translation.width
				committedPan.height += value.translation.height
			}
	}

	private var magnificationGesture: some Gesture {
		MagnifyGesture()
			.updating($activeMagnification) { value, state, _ in
				state = value.magnification
			}
			.onEnded { value in
				zoom = clampedZoom(zoom * value.magnification)
			}
	}

	private func point(for position: CanvasPosition, size: CGSize, pan: CGSize, zoom: CGFloat) -> CGPoint {
		CGPoint(
			x: size.width * 0.52 + CGFloat(position.x) * size.width * 0.52 * zoom + pan.width,
			y: size.height * 0.48 + CGFloat(position.y) * size.height * 0.56 * zoom + pan.height
		)
	}

	private func clampedZoom(_ value: CGFloat) -> CGFloat {
		min(max(value, 0.55), 1.8)
	}
}

private struct DotGrid: View {
	let spacing: CGFloat
	let offset: CGSize

	var body: some View {
		Canvas(opaque: true, colorMode: .linear) { context, size in
			context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(NetaTheme.canvas))
			let safeSpacing = max(spacing, 14)
			let startX = offset.width.truncatingRemainder(dividingBy: safeSpacing)
			let startY = offset.height.truncatingRemainder(dividingBy: safeSpacing)
			for x in stride(from: startX, through: size.width, by: safeSpacing) {
				for y in stride(from: startY, through: size.height, by: safeSpacing) {
					let dot = Path(ellipseIn: CGRect(x: x, y: y, width: 1.3, height: 1.3))
					context.fill(dot, with: .color(.white.opacity(0.115)))
				}
			}
		}
		.accessibilityHidden(true)
	}
}

private struct ConnectionLayer: View {
	let agents: [NetaAgent]
	let size: CGSize
	let pan: CGSize
	let zoom: CGFloat

	var body: some View {
		Canvas { context, _ in
			guard let leader = agents.first(where: { $0.kind == .leader }) else { return }
			let leaderPoint = point(for: leader.position)
			for agent in agents where agent.kind == .worker {
				let workerPoint = point(for: agent.position)
				var path = Path()
				path.move(to: leaderPoint)
				let distance = max(70, abs(workerPoint.x - leaderPoint.x) * 0.42)
				path.addCurve(
					to: workerPoint,
					control1: CGPoint(x: leaderPoint.x + distance, y: leaderPoint.y),
					control2: CGPoint(x: workerPoint.x - distance, y: workerPoint.y)
				)
				context.stroke(
					path,
					with: .linearGradient(
						Gradient(colors: [NetaTheme.violet.opacity(0.48), NetaTheme.agentColor(agent).opacity(0.32)]),
						startPoint: leaderPoint,
						endPoint: workerPoint
					),
					style: StrokeStyle(lineWidth: 1.4, lineCap: .round, dash: agent.state == .waiting ? [5, 6] : [])
				)
			}
		}
		.allowsHitTesting(false)
		.accessibilityHidden(true)
	}

	private func point(for position: CanvasPosition) -> CGPoint {
		CGPoint(
			x: size.width * 0.52 + CGFloat(position.x) * size.width * 0.52 * zoom + pan.width,
			y: size.height * 0.48 + CGFloat(position.y) * size.height * 0.56 * zoom + pan.height
		)
	}
}

private struct AgentNode: View {
	let agent: NetaAgent
	let isSelected: Bool
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			VStack(spacing: 9) {
				AgentAvatar(agent: agent, size: agent.kind == .leader ? 58 : 50)
				VStack(spacing: 2) {
					HStack(spacing: 5) {
						Text(agent.name)
							.font(.system(size: 13, weight: .semibold))
						if agent.kind == .leader {
							Text("LEADER")
								.font(.system(size: 8, weight: .black))
								.foregroundStyle(NetaTheme.violet)
								.padding(.horizontal, 5)
								.padding(.vertical, 2)
								.background(NetaTheme.violet.opacity(0.12), in: Capsule())
						}
					}
					Text(agent.role)
						.font(.system(size: 10, weight: .medium))
						.foregroundStyle(NetaTheme.secondaryText)
				}
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 13)
			.background(
				Color(red: 0.08, green: 0.09, blue: 0.11).opacity(0.96),
				in: RoundedRectangle(cornerRadius: 18, style: .continuous)
			)
			.overlay {
				RoundedRectangle(cornerRadius: 18, style: .continuous)
					.stroke(isSelected ? NetaTheme.accent : Color.white.opacity(0.10), lineWidth: isSelected ? 2 : 1)
			}
			.shadow(color: isSelected ? NetaTheme.accent.opacity(0.13) : .black.opacity(0.22), radius: 16, y: 7)
		}
		.buttonStyle(.plain)
		.animation(.easeOut(duration: 0.16), value: isSelected)
		.accessibilityHint("Open this agent’s chat")
	}
}

private struct CanvasToolbar: View {
	let projectName: String
	let zoom: CGFloat
	let onZoomOut: () -> Void
	let onReset: () -> Void
	let onZoomIn: () -> Void

	var body: some View {
		HStack(spacing: 10) {
			Text(projectName)
				.font(.system(size: 12, weight: .semibold))
			Divider().frame(height: 16)
			Button(action: onZoomOut) { Image(systemName: "minus") }
			Button(action: onReset) {
				Text("\(Int(zoom * 100))%")
					.font(.system(size: 10, weight: .semibold, design: .monospaced))
					.frame(width: 38)
			}
			Button(action: onZoomIn) { Image(systemName: "plus") }
		}
		.buttonStyle(.plain)
		.foregroundStyle(NetaTheme.primaryText.opacity(0.78))
		.padding(.horizontal, 12)
		.padding(.vertical, 9)
		.background(.ultraThinMaterial, in: Capsule())
		.overlay(Capsule().stroke(NetaTheme.panelBorder))
	}
}
