package com.ex

object Indented:
  val member = compute()
  def m(): Int =
    val local = helperI()
    local + 1

class IndentedC extends BaseI:
  def n(): Int = member

enum ColorI:
  case Red, Green
  def label(): String = "x"

trait TraitI:
  def tm(): Int

given ordI: Ordering[Int] = summonOrd()

extension (s: String)
  def extI: Int = s.length

def topI(): Int =
  if cond then one() else two()
