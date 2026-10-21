import XCTest
final class SafariTests: XCTestCase {
 let app = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
 override func setUpWithError() throws { continueAfterFailure=false; app.terminate(); XCUIDevice.shared.orientation = .portrait; app.open(URL(string:"__FIXTURE_BASE____FIXTURE_ENTRY__")!); let close=app.webViews.buttons["Close assistant"]; if close.exists {close.tap()} }
 func dismissKeyboardIntro() {let next=app.buttons["Continue"];if next.exists && next.isHittable {next.tap()}}
 func enter(_ text:String,into field:XCUIElement) {field.tap();dismissKeyboardIntro();if !app.keyboards.firstMatch.waitForExistence(timeout:3) {field.tap()};app.typeText(text);XCTAssertTrue((field.value as? String ?? "").contains(text),"Native typed text must reach the intended field before submitting")}
 func sendMessage() {let send=app.webViews.buttons["Send message"];XCTAssertTrue(send.waitForExistence(timeout:15));let ready=XCTNSPredicateExpectation(predicate:NSPredicate(format:"enabled == true"),object:send);XCTAssertEqual(XCTWaiter.wait(for:[ready],timeout:15),.completed,"Wait for prior stream and draft state before sending");send.tap()}
 override func tearDownWithError() throws {let a=XCTAttachment(string:app.debugDescription);a.name="final-native-hierarchy";a.lifetime = .keepAlways;add(a);shot("final-native-screen")}
 func shot(_ name:String) {let a=XCTAttachment(screenshot: app.screenshot());a.name=name;a.lifetime = .keepAlways;add(a)}
 func login() {
  let user=app.webViews.textFields["Username"]
  let editor=app.webViews.textViews["Type '/' for commands"].firstMatch
  let ready=XCTNSPredicateExpectation(predicate:NSPredicate { _,_ in user.exists || editor.exists },object:nil)
  XCTAssertEqual(XCTWaiter.wait(for:[ready],timeout:30),.completed,"Wait for authenticated page OR real sign-in form, not an arbitrary hydration delay")
  if user.exists {
   user.tap(); dismissKeyboardIntro(); if let value=user.value as? String,value != "ada" {user.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:value.count))};user.typeText("admin")
   let password=app.webViews.secureTextFields["Password"];if app.buttons["Next"].exists {app.buttons["Next"].tap()}else{password.tap()};password.typeText("password123");if app.buttons["Done"].exists {app.buttons["Done"].tap()}
   let form=app.webViews.otherElements.matching(NSPredicate(format:"label BEGINSWITH %@","Sign in form")).firstMatch
   XCTAssertTrue(form.waitForExistence(timeout:10));let submit=form.buttons["Sign in"];XCTAssertTrue(submit.isHittable);submit.tap()
  }
  do {XCTAssertTrue(editor.waitForExistence(timeout:30),"Fixture editor must load after browser session setup");XCTAssertTrue((editor.value as? String ?? "").contains("Safari fixture text"),"Exact fixture body must hydrate, not a stale route")}
 }
 func test01LoginEditingRotation() throws {
  login();shot("01-portrait-shell")
  let editor=app.webViews.textViews["Type '/' for commands"].firstMatch
  XCTAssertTrue(editor.waitForExistence(timeout:10));editor.tap();app.typeText(" Safari edit café 🚀")
  shot("02-editor-keyboard")
  XCUIDevice.shared.orientation = .landscapeLeft;shot("02b-editor-keyboard-landscape")
  XCUIDevice.shared.orientation = .portrait
  XCUIDevice.shared.press(.home);app.activate()
  XCTAssertTrue((editor.value as? String ?? "").contains("Safari edit café"),"Draft survives Safari background/foreground and rotation")
  if app.buttons["Done"].exists {app.buttons["Done"].tap()}
  app.webViews.buttons.matching(NSPredicate(format:"label BEGINSWITH %@", "Ask AI")).firstMatch.tap()
  XCTAssertTrue(app.webViews.buttons["Close assistant"].waitForExistence(timeout:10));app.webViews.buttons["Close assistant"].tap()
  XCTAssertTrue((editor.value as? String ?? "").contains("Safari edit café"));shot("03-edited-content")
  XCUIDevice.shared.orientation = .landscapeLeft
  XCTAssertTrue(editor.waitForExistence(timeout:8));shot("04-landscape")
  XCUIDevice.shared.orientation = .portrait;shot("05-portrait-return")
  app.open(URL(string:"__FIXTURE_BASE__/pages/apple-page")!)
  XCTAssertTrue(editor.waitForExistence(timeout:15));XCTAssertTrue((editor.value as? String ?? "").contains("Safari edit café"),"Unicode edit survives real route reload, not only a retained editor")
  shot("05b-reloaded-durable-edit")
 }
 func test02AssistantProposal() throws {
  login();app.webViews.buttons.matching(NSPredicate(format:"label BEGINSWITH %@", "Ask AI")).firstMatch.tap()
  XCTAssertTrue(app.webViews.staticTexts.matching(NSPredicate(format:"label CONTAINS %@", "Simulated provider")).firstMatch.waitForExistence(timeout:10),"Only simulated fixture provider may be used")
  let composer=app.webViews.textViews["Message the assistant"]
  XCTAssertTrue(composer.waitForExistence(timeout:10));enter("Summarize this page",into:composer)
  sendMessage()
  let reply=app.webViews.staticTexts.matching(NSPredicate(format:"label CONTAINS %@", "authorized sources")).firstMatch
  XCTAssertTrue(reply.waitForExistence(timeout:25));shot("06-sourced-assistant-keyboard")
  enter("/tool create_page {\"title\":\"Apple simulator proposed page\"}",into:composer)
  sendMessage()
  let proposal=app.webViews.buttons["Approve & execute"]
  XCTAssertTrue(proposal.waitForExistence(timeout:25));shot("07-proposal-keyboard")
  // Keep the native keyboard open and scroll only the named message region.
  let messages=app.webViews.otherElements.matching(NSPredicate(format:"label BEGINSWITH %@","Assistant messages")).firstMatch
  XCTAssertTrue(messages.waitForExistence(timeout:10))
  for _ in 0..<16 {
   let r=proposal.frame,m=messages.frame
   if m.contains(CGPoint(x:r.midX,y:r.midY)) {break}
   let from=messages.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5))
   let delta=max(-30,min(30,m.midY-r.midY))
   from.press(forDuration:0.1,thenDragTo:from.withOffset(CGVector(dx:0,dy:delta)),withVelocity:.slow,thenHoldForDuration:0.4)
  }
  XCTAssertTrue(app.keyboards.firstMatch.exists,"Inline approval must be exercised with software keyboard open")
  XCTAssertTrue(messages.frame.contains(CGPoint(x:proposal.frame.midX,y:proposal.frame.midY)),"Approval center must be inside actual transcript clip")
  shot("08-inline-human-review-keyboard");proposal.tap()
  let result=app.webViews.staticTexts.matching(NSPredicate(format:"label CONTAINS[c] %@", "Changeset")).firstMatch
  XCTAssertTrue(result.waitForExistence(timeout:25));shot("09-inline-executed-result")

 }
 func test03SearchNavigation() throws {
  login();app.webViews.buttons.matching(NSPredicate(format:"label BEGINSWITH %@", "Search")).firstMatch.tap()
  let query=app.webViews.textFields["Search workspace"]
  XCTAssertTrue(query.waitForExistence(timeout:10));enter("Safari task",into:query)
  let task=app.webViews.otherElements.matching(NSPredicate(format:"label BEGINSWITH %@", "Safari task fixture")).firstMatch
  XCTAssertTrue(task.waitForExistence(timeout:15));shot("09-search-keyboard")
  if app.buttons["Done"].exists {app.buttons["Done"].tap()};XCTAssertTrue(task.isHittable);task.tap();let title=app.webViews.textViews["Task title"];XCTAssertTrue(title.waitForExistence(timeout:15));shot("10-task-detail")
  let description=app.webViews.textViews["Task description"];enter("Safari property edit café",into:description)
  if app.buttons["Done"].exists {app.buttons["Done"].tap()};app.webViews.buttons["Close"].firstMatch.tap()
 }
 func openCanvas() -> XCUIElement {
  login();let search=app.webViews.buttons.matching(NSPredicate(format:"label BEGINSWITH %@", "Search")).firstMatch
  XCTAssertTrue(search.waitForExistence(timeout:15));search.tap()
  let query=app.webViews.textFields["Search workspace"];XCTAssertTrue(query.waitForExistence(timeout:10));enter("Apple Safari canvas",into:query)
  let result=app.webViews.otherElements.matching(NSPredicate(format:"label BEGINSWITH %@", "Apple Safari canvas")).firstMatch
  XCTAssertTrue(result.waitForExistence(timeout:15));if app.buttons["Done"].exists {app.buttons["Done"].tap()};XCTAssertTrue(result.isHittable);result.tap()
  let canvas=app.webViews.otherElements.matching(NSPredicate(format:"label BEGINSWITH %@","Moodboard canvas")).firstMatch
  XCTAssertTrue(canvas.waitForExistence(timeout:15));XCTAssertTrue(app.webViews.buttons["Zoom in"].waitForExistence(timeout:15));return canvas
 }
 func test04CanvasAlternatives() throws {
  let canvas=openCanvas();shot("11-canvas")
  let note=app.webViews.staticTexts["Apple canvas note"].firstMatch;XCTAssertTrue(note.waitForExistence(timeout:8));let originalWidth=note.frame.width
  app.webViews.buttons["Zoom in"].press(forDuration:0.1)
  let enlarged=XCTNSPredicateExpectation(predicate:NSPredicate { _,_ in note.frame.width > originalWidth+1 },object:nil)
  XCTAssertEqual(XCTWaiter.wait(for:[enlarged],timeout:5),.completed,"Zoom in must change actual rendered geometry before the next control")
  app.webViews.buttons["Zoom out"].press(forDuration:0.1)
  let restored=XCTNSPredicateExpectation(predicate:NSPredicate { _,_ in abs(note.frame.width-originalWidth)<2 },object:nil)
  XCTAssertEqual(XCTWaiter.wait(for:[restored],timeout:5),.completed,"Zoom out must restore geometry; a click retargeted to Zoom in cannot pass")
  app.webViews.buttons["Fit to content"].press(forDuration:0.1)
  // Fixture card is 220×140; text starts 12 world pixels inside its left edge.
  let fitted=XCTNSPredicateExpectation(predicate:NSPredicate { _,_ in abs(note.frame.minX-(canvas.frame.midX-(220/2-12)*min((canvas.frame.width-80)/220,(canvas.frame.height-80)/140,2)))<4 },object:nil)
  XCTAssertEqual(XCTWaiter.wait(for:[fitted],timeout:5),.completed,"Fit must position the fixture text at the fitted item left plus its 12px scaled inset (not center the intrinsic AX text frame)")
  let list=app.webViews.buttons["Item list"];XCTAssertTrue(list.isHittable);list.press(forDuration:0.1);XCTAssertTrue(app.webViews.textFields["Filter items"].waitForExistence(timeout:8))
  let nudge=app.webViews.buttons["Nudge right"].firstMatch;XCTAssertTrue(nudge.exists);nudge.tap();shot("12-canvas-nondrag-controls")
  app.webViews.buttons["Close item list"].tap()
  let before=note.frame
  // Deliberately begin over an item: Browse mode must pan the view, not move data.
  note.coordinate(withNormalizedOffset:CGVector(dx:0.6,dy:0.5)).press(forDuration:0.05,thenDragTo:note.coordinate(withNormalizedOffset:CGVector(dx:0.6,dy:0.5)).withOffset(CGVector(dx:-60,dy:0)))
  XCTAssertGreaterThan(abs(note.frame.minX-before.minX),40,"Browse drag over an item must pan rendered geometry")
  XCTAssertEqual(note.frame.width,before.width,accuracy:2);XCTAssertTrue(canvas.exists);shot("13-independent-pan")
 }
 func test05CanvasPinch() throws {
  let canvas=openCanvas();app.webViews.buttons["Fit to content"].tap()
  let note=app.webViews.staticTexts["Apple canvas note"].firstMatch;XCTAssertTrue(note.waitForExistence(timeout:8))
  let before=note.frame;canvas.pinch(withScale:0.8,velocity:-1)
  XCTAssertLessThan(note.frame.width,before.width-5,"Pinch on the labelled canvas must change rendered geometry")
  shot("14-independent-pinch")
 }
}
