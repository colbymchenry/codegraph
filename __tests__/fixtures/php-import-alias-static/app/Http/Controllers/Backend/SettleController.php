<?php
namespace App\Http\Controllers\Backend;
use App\Services\SettleService as Settle;

class SettleController extends Controller {
    public function excel($stores, $startDay = null, $endDay = null, $id = null) {
        return Settle::getSettlesToExcel($stores, request()->_SELECTED, [$startDay, $endDay], $id);
    }
}
