package io.github.iroha1145.cloudmonitor.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate

class SubscriptionScheduleTest {
    private val today = LocalDate.parse("2026-10-07")

    @Test fun monthlyStartProjectsTheNextBoundaryOnOrAfterToday() {
        assertEquals(
            "2026-10-15",
            nextRenewalDate("subscription", true, null, "2026-01-15", "month", 1, today),
        )
    }

    @Test fun anchorDaySurvivesAShortMonth() {
        assertEquals(
            "2026-03-31",
            nextRenewalDate("subscription", true, null, "2026-01-31", "month", 1, LocalDate.parse("2026-03-15")),
        )
    }

    @Test fun futureOverrideWinsAndAPastOverrideIsIgnored() {
        assertEquals(
            "2026-12-01",
            nextRenewalDate("subscription", true, "2026-12-01T00:00:00Z", "2026-01-15", "month", 1, today),
        )
        assertEquals(
            "2026-11-01",
            nextRenewalDate("subscription", true, "2026-09-01", "2026-01-01", "month", 1, today),
        )
    }

    @Test fun stoppedPlansAndMissingAnchorsStayUnknown() {
        assertNull(nextRenewalDate("subscription", false, null, "2026-01-15", "month", 1, today))
        assertNull(nextRenewalDate("subscription", true, null, null, "month", 1, today))
        assertNull(nextRenewalDate("topup", true, null, "2026-01-15", "month", 1, today))
    }

    @Test fun yearlyIntervalStepsTwelveMonths() {
        assertEquals(
            "2027-01-15",
            nextRenewalDate("subscription", true, null, "2026-01-15", "year", 1, today),
        )
    }
}
