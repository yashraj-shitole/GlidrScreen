package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.net.ActionResult
import com.yashraj.glidr.screen.net.Msg
import com.yashraj.glidr.screen.net.QuickAction
import com.yashraj.glidr.screen.ui.QuickActionText
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Wire format and wording of quick actions (docs/PROTOCOL.md, "Quick actions"). */
class QuickActionsTest {
    private fun flat(o: JSONObject) = o.keys().asSequence().associateWith { o.get(it) }

    @Test fun actionMessageCarriesOnlyAnId() {
        val m = Msg.action("lock")
        assertEquals(setOf("t", "id", "confirm"), m.keys().asSequence().toSet()) // no command, path or arguments can be added
        assertEquals(mapOf("t" to "action", "id" to "lock", "confirm" to false), flat(JSONObject(m.toString())))
        assertEquals(mapOf("t" to "action", "id" to "restart", "confirm" to true), flat(JSONObject(Msg.action("restart", true).toString())))
    }

    @Test fun parsesTheHelloList() {
        val arr = JSONArray(
            """[{"id":"lock","label":"Lock PC","danger":false},{"id":"restart","label":"Restart PC","danger":true},
                {"id":"0a1b2c3d","label":"Open notes","danger":false}]""",
        )
        assertEquals(
            listOf(QuickAction("lock", "Lock PC", false), QuickAction("restart", "Restart PC", true), QuickAction("0a1b2c3d", "Open notes", false)),
            QuickAction.parseAll(arr),
        )
    }

    @Test fun missingOrEmptyListMeansNone() {
        assertEquals(emptyList<QuickAction>(), QuickAction.parseAll(null)) // an older host sends no `actions`
        assertEquals(emptyList<QuickAction>(), QuickAction.parseAll(JSONArray("[]")))
    }

    @Test fun dropsMalformedEntries() {
        val arr = JSONArray(
            """[{"id":"LOCK","label":"x"},{"id":"a b","label":"x"},{"id":"../x","label":"x"},{"id":5,"label":"x"},{"label":"no id"},
                "text",null,{"id":"","label":"x"},{"id":"${"a".repeat(25)}","label":"x"},
                {"id":"ok","label":"Fine","danger":"yes"},{"id":"ok","label":"Duplicate"}]""",
        )
        // danger must be the JSON boolean true; a string is not
        assertEquals(listOf(QuickAction("ok", "Fine", false)), QuickAction.parseAll(arr))
    }

    @Test fun labelsAreCleanedAndCut() {
        val arr = JSONArray().put(JSONObject().put("id", "a").put("label", "Evil\u0000\n‮Name"))
            .put(JSONObject().put("id", "b").put("label", "x".repeat(200))).put(JSONObject().put("id", "c"))
        val list = QuickAction.parseAll(arr)
        assertEquals("Evil Name", list[0].label)
        assertEquals(QuickAction.MAX_LABEL, list[1].label.length)
        assertEquals("c", list[2].label) // no label: the id
    }

    @Test fun listIsCapped() {
        val arr = JSONArray()
        for (i in 0 until 100) arr.put(JSONObject().put("id", "a$i").put("label", "L$i"))
        assertEquals(QuickAction.MAX_ACTIONS, QuickAction.parseAll(arr).size)
    }

    @Test fun idFormat() {
        for (ok in listOf("lock", "cancel-shutdown", "0a1b2c3d")) assertTrue(ok, QuickAction.validId(ok))
        for (bad in listOf("", "Lock", "lock;calc", "lock calc", "a".repeat(25), "lock\n")) assertFalse(bad, QuickAction.validId(bad))
        assertFalse(QuickAction.validId(null))
    }

    @Test fun parsesResults() {
        assertEquals(ActionResult("lock", true, null), ActionResult.parse(JSONObject("""{"t":"action-result","id":"lock","ok":true}""")))
        assertEquals(
            ActionResult("restart", false, "confirm"),
            ActionResult.parse(JSONObject("""{"t":"action-result","id":"restart","ok":false,"reason":"confirm"}""")),
        )
        assertEquals(ActionResult("lock", false, null), ActionResult.parse(JSONObject("""{"t":"action-result","id":"lock","ok":"true"}""")))
        assertNull(ActionResult.parse(JSONObject("""{"t":"action-result","id":"LOCK","ok":true}""")))
        assertNull(ActionResult.parse(JSONObject("""{"t":"action-result","ok":true}""")))
        assertNull(ActionResult.parse(JSONObject("""{"t":"pong","id":"lock","ok":true}""")))
        // a malformed reason is dropped, the result itself is kept
        assertNull(ActionResult.parse(JSONObject("""{"t":"action-result","id":"lock","ok":false,"reason":"Bad Reason!"}"""))?.reason)
    }

    @Test fun resultTexts() {
        assertEquals("Done", ActionResult("lock", true, null).message)
        assertEquals("Shutdown cancelled", ActionResult("cancel-shutdown", true, null).message)
        assertEquals("Switched off on the PC", ActionResult("lock", false, "disabled").message)
        assertEquals("Too many actions, wait a moment", ActionResult("lock", false, "rate").message)
        assertEquals("This phone is view only", ActionResult("lock", false, "view-only").message)
        assertEquals("Please confirm first", ActionResult("restart", false, "confirm").message)
        assertEquals("No longer available on the PC", ActionResult("x", false, "unknown").message)
        assertEquals("The PC could not run that", ActionResult("x", false, "failed").message)
        assertEquals("Not connected to the PC", ActionResult("x", false, "offline").message)
        assertEquals("The PC did not do that", ActionResult("x", false, null).message)
        assertEquals("The PC did not do that", ActionResult("x", false, "something-new").message)
    }

    @Test fun confirmWording() {
        val restart = QuickAction("restart", "Restart PC", true)
        val shutdown = QuickAction("shutdown", "Shut down PC", true)
        assertEquals("Restart the PC? It restarts in 15 seconds. You can cancel from here.", QuickActionText.confirmQuestion(restart))
        assertEquals("Shut down the PC? It shuts down in 15 seconds. You can cancel from here.", QuickActionText.confirmQuestion(shutdown))
        assertEquals("Restart", QuickActionText.confirmButton(restart))
        assertEquals("Shut down", QuickActionText.confirmButton(shutdown))
        assertTrue(QuickActionText.needsConfirm(restart))
        assertFalse(QuickActionText.needsConfirm(QuickAction("lock", "Lock PC", false)))
    }

    @Test fun cancelShutdownRowOnlyWhileCountingDown() {
        val all = listOf(
            QuickAction("lock", "Lock PC", false), QuickAction("restart", "Restart PC", true), QuickAction("cancel-shutdown", "Cancel shutdown", false),
        )
        assertEquals(listOf("lock", "restart"), QuickActionText.listed(all).map { it.id }) // never in the plain list
        assertNull(QuickActionText.cancelRow(all, pending = false))
        assertEquals("cancel-shutdown", QuickActionText.cancelRow(all, pending = true)?.id)
        assertNull(QuickActionText.cancelRow(all.take(2), pending = true)) // the PC does not offer it
    }
}
