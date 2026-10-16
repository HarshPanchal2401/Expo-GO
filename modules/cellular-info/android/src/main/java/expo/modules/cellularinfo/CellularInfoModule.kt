package expo.modules.cellularinfo

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.CellIdentityNr
import android.telephony.TelephonyManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Reads the cells Android reports (serving + neighbours). Read-only: no GPS, no
 * Wi-Fi, no network. A value Android marks unavailable (Int.MAX_VALUE /
 * Long.MAX_VALUE) is returned as null - never as 0.
 */
class CellularInfoModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())

  private fun ctx(): Context =
    appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "React context is not available", null)

  /** Int that Android marks as "unavailable" -> null. */
  private fun ok(v: Int): Int? = if (v == Int.MAX_VALUE) null else v

  private fun ok(v: Long): Long? = if (v == Long.MAX_VALUE) null else v

  @Suppress("DEPRECATION")
  private fun cellMap(
    radio: String,
    registered: Boolean,
    mcc: String?,
    mnc: String?,
    areaCode: Int?,
    cellId: Long?,
    pci: Int?,
    signalDbm: Int?,
    info: CellInfo
  ): Map<String, Any?> {
    val ageMs: Long? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        SystemClock.elapsedRealtime() - info.timestampMillis
      } else {
        (SystemClock.elapsedRealtimeNanos() - info.timeStamp) / 1_000_000L
      }
    return mapOf(
      "radio" to radio,
      "registered" to registered,
      "mcc" to mcc,
      "mnc" to mnc,
      "areaCode" to areaCode,
      // Decimal string: an NR cell identity (36 bits) does not fit a 32-bit int.
      "cellId" to cellId?.toString(),
      "pci" to pci,
      "signalDbm" to signalDbm,
      "ageMs" to ageMs,
      "supported" to true
    )
  }

  private fun unsupported(radio: String, info: CellInfo): Map<String, Any?> = mapOf(
    "radio" to radio,
    "registered" to info.isRegistered,
    "mcc" to null, "mnc" to null, "areaCode" to null, "cellId" to null,
    "pci" to null, "signalDbm" to null, "ageMs" to null,
    "supported" to false
  )

  private fun mccMnc(mccString: String?, mncString: String?, mccInt: Int, mncInt: Int): Pair<String?, String?> {
    // The String forms exist from API 28; older versions only have the int forms.
    val mcc = mccString ?: ok(mccInt)?.toString()
    val mnc = mncString ?: ok(mncInt)?.toString()
    return Pair(mcc, mnc)
  }

  @Suppress("DEPRECATION")
  private fun convert(info: CellInfo): Map<String, Any?> {
    when (info) {
      is CellInfoLte -> {
        val id = info.cellIdentity
        val (mcc, mnc) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          mccMnc(id.mccString, id.mncString, Int.MAX_VALUE, Int.MAX_VALUE)
        } else {
          mccMnc(null, null, id.mcc, id.mnc)
        }
        return cellMap(
          "LTE", info.isRegistered, mcc, mnc, ok(id.tac), ok(id.ci)?.toLong(), ok(id.pci),
          ok(info.cellSignalStrength.dbm), info
        )
      }
      is CellInfoGsm -> {
        val id = info.cellIdentity
        val (mcc, mnc) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          mccMnc(id.mccString, id.mncString, Int.MAX_VALUE, Int.MAX_VALUE)
        } else {
          mccMnc(null, null, id.mcc, id.mnc)
        }
        return cellMap(
          "GSM", info.isRegistered, mcc, mnc, ok(id.lac), ok(id.cid)?.toLong(), null,
          ok(info.cellSignalStrength.dbm), info
        )
      }
      is CellInfoWcdma -> {
        val id = info.cellIdentity
        val (mcc, mnc) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          mccMnc(id.mccString, id.mncString, Int.MAX_VALUE, Int.MAX_VALUE)
        } else {
          mccMnc(null, null, id.mcc, id.mnc)
        }
        // Radio name for OpenCelliD is UMTS.
        return cellMap(
          "UMTS", info.isRegistered, mcc, mnc, ok(id.lac), ok(id.cid)?.toLong(), ok(id.psc),
          ok(info.cellSignalStrength.dbm), info
        )
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && info is CellInfoNr) {
      val id = info.cellIdentity as CellIdentityNr
      return cellMap(
        "NR", info.isRegistered, id.mccString, id.mncString, ok(id.tac), ok(id.nci), ok(id.pci),
        ok(info.cellSignalStrength.dbm), info
      )
    }
    // CDMA, TD-SCDMA and anything else: reported, but not looked up.
    val name = info.javaClass.simpleName.removePrefix("CellInfo").uppercase()
    return unsupported(name, info)
  }

  private fun base(tm: TelephonyManager?, hasTelephony: Boolean, granted: Boolean): MutableMap<String, Any?> {
    val lm = ctx().getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    val locOn: Boolean? =
      if (lm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) lm.isLocationEnabled else null
    return mutableMapOf(
      "hasTelephony" to hasTelephony,
      "permissionGranted" to granted,
      "locationServicesOn" to locOn,
      "simState" to tm?.simState,
      "operatorName" to tm?.networkOperatorName?.takeIf { it.isNotBlank() },
      "operator" to tm?.networkOperator?.takeIf { it.isNotBlank() },
      "apiLevel" to Build.VERSION.SDK_INT,
      "cells" to emptyList<Map<String, Any?>>()
    )
  }

  @Suppress("MissingPermission")
  override fun definition() = ModuleDefinition {
    Name("CellularInfo")

    AsyncFunction("getCellInfo") { promise: Promise ->
      val context = ctx()
      val hasTelephony = context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
      val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
      val granted = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
      val out = base(tm, hasTelephony, granted)

      if (!hasTelephony || tm == null || !granted) {
        promise.resolve(out)
        return@AsyncFunction
      }

      val done = AtomicBoolean(false)
      fun finish(list: List<CellInfo>?, error: String?) {
        if (!done.compareAndSet(false, true)) return
        out["cells"] = (list ?: emptyList()).map { convert(it) }
        if (error != null) out["error"] = error
        promise.resolve(out)
      }

      @Suppress("MissingPermission")
      fun cached() {
        try {
          finish(tm.allCellInfo, null)
        } catch (e: SecurityException) {
          finish(null, "security-exception")
        } catch (e: Exception) {
          finish(null, e.javaClass.simpleName)
        }
      }

      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          // A fresh scan; if it does not answer in 3 s, fall back to Android's cached list.
          mainHandler.postDelayed({ cached() }, 3000)
          tm.requestCellInfoUpdate(
            context.mainExecutor,
            object : TelephonyManager.CellInfoCallback() {
              override fun onCellInfo(cellInfo: MutableList<CellInfo>) = finish(cellInfo, null)
              override fun onError(errorCode: Int, detail: Throwable?) = cached()
            }
          )
        } else {
          cached()
        }
      } catch (e: SecurityException) {
        finish(null, "security-exception")
      } catch (e: Exception) {
        finish(null, e.javaClass.simpleName)
      }
    }
  }
}
