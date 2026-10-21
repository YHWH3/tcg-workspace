import XCTest
final class SafariTests: XCTestCase {
 let app = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
 override func setUpWithError() throws { continueAfterFailure=false; XCUIDevice.shared.orientation = .portrait; app.open(URL(string:"__FIXTURE_BASE____FIXTURE_ENTRY__")!); let close=app.webViews.buttons["Close assistant"]; if close.exists {close.tap()} }
 func dismissKeyboardIntro() {let next=app.buttons["Continue"];if next.exists && next.isHittable {next.tap()}}
 func enter(_ text:String,into field:XCUIElement) {field.tap();dismissKeyboardIntro();if !app.keyboards.firstMatch.waitForExistence(timeout:3) {field.tap()};app.typeText(text);XCTAssertTrue((field.value as? String ?? "").contains(text),"Native typed text must reach the intended field before submitting")}
 func sendMessage() {let send=app.webViews.buttons["Send message"];XCTAssertTrue(send.waitForExistence(timeout:15));let ready=XCTNSPredicateExpectation(predicate:NSPredicate(format:"enabled == true"),object:send);XCTAssertEqual(XCTWaiter.wait(for:[ready],timeout:15),.completed,"Wait for prior stream and draft state before sending");send.tap()}
 func shot(_ name:String) {let a=XCTAttachment(screenshot: app.screenshot());a.name=name;a.lifetime = .keepAlways;add(a)}
 func login(requirePage:Bool=true) {
  let user=app.webViews.textFields["Username"]
  if user.waitForExistence(timeout:3) {
   user.tap(); dismissKeyboardIntro(); if let value=user.value as? String,value != "ada" {user.typeText(String(repeating:XCUIKeyboardKey.delete.rawValue,count:value.count))};user.typeText("admin")
   let password=app.webViews.secureTextFields["Password"];if app.buttons["Next"].exists {app.buttons["Next"].tap()}else{password.tap()};password.typeText("password123");if app.buttons["Done"].exists {app.buttons["Done"].tap()}
   app.webViews.buttons.matching(identifier:"Sign in").element(boundBy:1).tap()
  }
  if requirePage {XCTAssertTrue(app.webViews.staticTexts["Apple Safari acceptance"].firstMatch.waitForExistence(timeout:20),"Fixture page must load after browser session setup")}
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
  // Standard browser fallback: review the full frozen plan with the keyboard
  // dismissed. This does not certify keyboard-open inline approval hit testing.
  if app.buttons["Done"].exists {app.buttons["Done"].tap()}
  let review=app.webViews.links["Open full review"];XCTAssertTrue(review.waitForExistence(timeout:10));review.tap()
  let close=app.webViews.buttons["Close assistant"];if close.exists {close.tap()}
  XCTAssertTrue(app.webViews.staticTexts["Review proposed changes"].waitForExistence(timeout:15));shot("08-full-human-review")
  let approve=app.webViews.buttons["Approve exact changes"];XCTAssertTrue(approve.waitForExistence(timeout:10));approve.tap()
  let execute=app.webViews.buttons["Resume execution"];XCTAssertTrue(execute.waitForExistence(timeout:15));execute.tap()
  let result=app.webViews.staticTexts.matching(NSPredicate(format:"label CONTAINS[c] %@", "Completed. Changeset")).firstMatch
  XCTAssertTrue(result.waitForExistence(timeout:25));shot("09-executed-result")
 }
 func test03SearchNavigation() throws {
  login();app.webViews.buttons.matching(NSPredicate(format:"label BEGINSWITH %@", "Search")).firstMatch.tap()
  let query=app.webViews.textFields["Search workspace"]
  XCTAssertTrue(query.waitForExistence(timeout:10));enter("Safari task",into:query)
  let task=app.webViews.otherElements.matching(NSPredicate(format:"label BEGINSWITH %@", "Safari task fixture")).firstMatch
  XCTAssertTrue(task.waitForExistence(timeout:15));shot("09-search-keyboard")
  task.tap();let title=app.webViews.textViews["Task title"];XCTAssertTrue(title.waitForExistence(timeout:15));shot("10-task-detail")
  let description=app.webViews.textViews["Task description"];enter("Safari property edit café",into:description)
  if app.buttons["Done"].exists {app.buttons["Done"].tap()};app.webViews.buttons["Close"].firstMatch.tap()
 }
 func test04CanvasAlternatives() throws {
  login(requirePage:false);app.webViews.buttons.matching(NSPredicate(format:"label BEGINSWITH %@", "Search")).firstMatch.tap()
  let query=app.webViews.textFields["Search workspace"];XCTAssertTrue(query.waitForExistence(timeout:10));enter("Apple Safari canvas",into:query)
  let result=app.webViews.otherElements.matching(NSPredicate(format:"label BEGINSWITH %@", "Apple Safari canvas")).firstMatch
  XCTAssertTrue(result.waitForExistence(timeout:15));result.tap()
  let canvas=app.webViews.firstMatch;XCTAssertTrue(app.webViews.buttons["Zoom in"].waitForExistence(timeout:15));shot("11-canvas")
  let note=app.webViews.staticTexts["Apple canvas note"].firstMatch;XCTAssertTrue(note.waitForExistence(timeout:8));let originalWidth=note.frame.width
  app.webViews.buttons["Zoom in"].tap();XCTAssertGreaterThan(note.frame.width,originalWidth+1);app.webViews.buttons["Zoom out"].tap();app.webViews.buttons["Fit to content"].tap()
  app.webViews.buttons["Item list"].tap();XCTAssertTrue(app.webViews.textFields["Filter items"].waitForExistence(timeout:8))
  let nudge=app.webViews.buttons["Nudge right"].firstMatch;XCTAssertTrue(nudge.exists);nudge.tap();shot("12-canvas-nondrag-controls")
  app.webViews.buttons["Close item list"].tap()
  let beforePinch=note.frame;canvas.pinch(withScale:0.8,velocity:-1);let afterPinch=note.frame;XCTAssertLessThan(afterPinch.width,beforePinch.width-1,"Canvas pinch must change rendered item geometry")
  canvas.swipeLeft();XCTAssertGreaterThan(abs(note.frame.minX-afterPinch.minX),5,"Canvas pan must move rendered items");shot("13-canvas-pinch-pan")
 }
}
